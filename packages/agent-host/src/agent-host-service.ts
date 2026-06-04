import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  AgentRun,
  AgentRunRegistry,
  type AgentHostCommand,
  type AgentHostCommandErrorCode,
  type AgentHostCommandResponse,
  type AgentHostEvent,
  type AgentHostIdentity,
  type AgentHostResumeRunRequest,
  type AgentHostRunSnapshot,
  type AgentHostStartRunRequest,
  type AgentHostTerminalResult,
  type AgentRunInput,
  type SpawnFactory,
} from '@pc/runtime';

export const AGENT_HOST_PROTOCOL_VERSION = 1 as const;

const DEFAULT_EVENT_BUFFER_LIMIT = 1_000;

export interface AgentHostServiceOptions {
  hostId?: string;
  pid?: number;
  startedAt?: number;
  maxConcurrent?: number;
  eventBufferLimit?: number;
  spawnFactory?: SpawnFactory;
  now?: () => number;
}

type HostRunRequest = AgentHostStartRunRequest | AgentHostResumeRunRequest;
type AgentHostEventPayload = AgentHostEvent extends infer Event
  ? Event extends AgentHostEvent
    ? Omit<Event, 'seq'>
    : never
  : never;

interface HostRunEntry {
  run: AgentRun;
  request: HostRunRequest;
  terminalResult?: AgentHostTerminalResult;
  updatedAt: number;
}

export class AgentHostService extends EventEmitter {
  private readonly identity: AgentHostIdentity;
  private readonly registry: AgentRunRegistry;
  private readonly spawnFactory?: SpawnFactory;
  private readonly now: () => number;
  private readonly eventBufferLimit: number;
  private readonly runs = new Map<string, HostRunEntry>();
  private readonly ccSessionIndex = new Map<string, string>();
  private readonly events: AgentHostEvent[] = [];
  private seq = 0;
  private hostReadyEmitted = false;
  private shuttingDown = false;

  constructor(options: AgentHostServiceOptions = {}) {
    super();
    this.now = options.now ?? (() => Date.now());
    this.identity = {
      hostId: options.hostId ?? randomUUID(),
      pid: options.pid ?? process.pid,
      startedAt: options.startedAt ?? this.now(),
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    };
    this.registry = new AgentRunRegistry({
      maxConcurrent: options.maxConcurrent,
    });
    this.spawnFactory = options.spawnFactory;
    this.eventBufferLimit =
      options.eventBufferLimit ?? DEFAULT_EVENT_BUFFER_LIMIT;
  }

  getIdentity(): AgentHostIdentity {
    return { ...this.identity };
  }

  /** FD-15 — effective concurrency cap (exposed on /health for positive
   *  receipt that a set-config push landed). */
  getMaxConcurrent(): number {
    return this.registry.getMaxConcurrent();
  }

  getLastSeq(): number {
    return this.seq;
  }

  getEventsAfter(seq: number): AgentHostEvent[] {
    return this.events.filter((event) => event.seq > seq);
  }

  emitReady(): AgentHostEvent {
    if (this.hostReadyEmitted) {
      const ready = this.events.find((event) => event.type === 'host-ready');
      if (ready) return ready;
    }
    this.hostReadyEmitted = true;
    return this.appendEvent({ type: 'host-ready', identity: this.getIdentity() });
  }

  async handleCommand(
    command: AgentHostCommand,
  ): Promise<AgentHostCommandResponse> {
    switch (command.type) {
      case 'hello':
        if (command.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) {
          return this.error(
            command.type,
            'protocol-error',
            `unsupported protocol version ${command.protocolVersion}`,
          );
        }
        this.emitReady();
        return {
          ok: true,
          command: 'hello',
          identity: this.getIdentity(),
          lastSeq: this.seq,
        };
      case 'list-runs':
        return {
          ok: true,
          command: 'list-runs',
          runs: this.listRunSnapshots(),
          lastSeq: this.seq,
        };
      case 'start-run':
        return this.startRun('start-run', command.request);
      case 'resume-run':
        return this.startRun('resume-run', command.request);
      case 'send':
        return this.send(command.runId, command.text);
      case 'interrupt':
        return this.interrupt(command.runId);
      case 'resize':
        return this.resize(command.runId, command.cols, command.rows);
      case 'write-raw':
        return this.writeRaw(command.runId, command.data);
      case 'mark-paused':
        return this.markPaused(command.runId, command.askId);
      case 'answer-pending':
        return this.answerPending(command.runId, command.text);
      case 'cancel':
        return this.cancel(command.runId);
      case 'complete-run':
        return this.completeRun(command.runId, command.result);
      case 'notify-mcp-handshake':
        return this.notifyMcpHandshake(command.ccSessionId);
      case 'set-config':
        // FD-15 — live cap update. Raising admits queued runs immediately;
        // lowering never revokes admitted slots (over-cap drains on release).
        return {
          ok: true,
          command: 'set-config',
          maxConcurrent: this.registry.setMaxConcurrent(command.maxConcurrent),
          lastSeq: this.seq,
        };
      case 'shutdown':
        return this.shutdown(command.mode);
      default:
        return this.error(
          (command as AgentHostCommand).type,
          'unsupported',
          'unsupported host command',
        );
    }
  }

  private startRun(
    command: 'start-run' | 'resume-run',
    request: HostRunRequest,
  ): AgentHostCommandResponse {
    if (this.shuttingDown) {
      return this.error(command, 'host-shutting-down', 'host is shutting down');
    }
    if (this.runs.has(request.runId)) {
      return this.error(command, 'run-exists', `run ${request.runId} already exists`);
    }
    if (this.ccSessionIndex.has(request.ccSessionId)) {
      return this.error(
        command,
        'run-exists',
        `cc session ${request.ccSessionId} already has an active run`,
      );
    }

    const run = new AgentRun(this.toAgentRunInput(request), {
      registry: this.registry,
      spawnFactory: this.spawnFactory,
      now: this.now,
    });
    const entry: HostRunEntry = {
      run,
      request,
      updatedAt: this.now(),
    };

    this.runs.set(request.runId, entry);
    this.ccSessionIndex.set(request.ccSessionId, request.runId);
    this.wireRun(entry);
    run.start();
    this.emitRunState(entry);

    return {
      ok: true,
      command,
      run: this.snapshot(entry),
      lastSeq: this.seq,
    };
  }

  private async send(
    runId: string,
    text: string,
  ): Promise<AgentHostCommandResponse> {
    const entry = this.runs.get(runId);
    if (!entry) {
      return this.error('send', 'not-found', `run ${runId} not found`);
    }

    const result = await entry.run.send(text);
    if (result !== 'ok') {
      this.appendEvent({
        type: 'run-error',
        runId: entry.request.runId,
        error: `send failed: ${result}`,
      });
      return this.error('send', 'send-failed', `send failed: ${result}`);
    }

    entry.updatedAt = this.now();
    return {
      ok: true,
      command: 'send',
      run: this.snapshot(entry),
      lastSeq: this.seq,
    };
  }

  /** Step-4 G2 — graceful interrupt (Escape). Non-destructive; `cancel`
   *  remains the kill path. */
  private interrupt(runId: string): AgentHostCommandResponse {
    const entry = this.runs.get(runId);
    if (!entry) {
      return this.error('interrupt', 'not-found', `run ${runId} not found`);
    }

    entry.run.interrupt();
    entry.updatedAt = this.now();
    return {
      ok: true,
      command: 'interrupt',
      run: this.snapshot(entry),
      lastSeq: this.seq,
    };
  }

  /** Step-4 G6 — terminal-grade resize for interactive surfaces. */
  private resize(
    runId: string,
    cols: number,
    rows: number,
  ): AgentHostCommandResponse {
    const entry = this.runs.get(runId);
    if (!entry) {
      return this.error('resize', 'not-found', `run ${runId} not found`);
    }

    entry.run.resize(cols, rows);
    entry.updatedAt = this.now();
    return {
      ok: true,
      command: 'resize',
      run: this.snapshot(entry),
      lastSeq: this.seq,
    };
  }

  /** Step-4 Slice 2 — raw terminal keystrokes (terminal-mode input). */
  private writeRaw(runId: string, data: string): AgentHostCommandResponse {
    const entry = this.runs.get(runId);
    if (!entry) {
      return this.error('write-raw', 'not-found', `run ${runId} not found`);
    }

    if (!entry.run.writeRaw(data)) {
      return this.error('write-raw', 'send-failed', 'PTY rejected raw input');
    }
    entry.updatedAt = this.now();
    return {
      ok: true,
      command: 'write-raw',
      run: this.snapshot(entry),
      lastSeq: this.seq,
    };
  }

  private markPaused(runId: string, askId: string): AgentHostCommandResponse {
    const entry = this.runs.get(runId);
    if (!entry) {
      return this.error('mark-paused', 'not-found', `run ${runId} not found`);
    }

    entry.run._markPaused(askId);
    entry.updatedAt = this.now();
    return {
      ok: true,
      command: 'mark-paused',
      run: this.snapshot(entry),
      lastSeq: this.seq,
    };
  }

  private answerPending(runId: string, text: string): AgentHostCommandResponse {
    const entry = this.runs.get(runId);
    if (!entry) {
      return this.error(
        'answer-pending',
        'not-found',
        `run ${runId} not found`,
      );
    }

    // Slice 009 OBJ-2 — `_resumeWithAnswer` silently no-ops if the host-side run
    // is not `paused` (or is `cancelling`); the answer is then never threaded as
    // the next user turn and the server, on a stale-snapshot `ok`, leaves the run
    // stranded `running` until the idle sweep. Observe the state transition: if
    // the run did not leave `paused`, surface a typed `not-resumable` error so the
    // server finalizes via `resume-failed` instead of stranding.
    const stateBefore = entry.run.getState();
    entry.run._resumeWithAnswer(text);
    const stateAfter = entry.run.getState();
    entry.updatedAt = this.now();

    // The run transitions paused -> spawning -> ... on a successful resume. If it
    // is still `paused` after the call, `_resumeWithAnswer` was a no-op (run not
    // resumable) and the answer was dropped.
    if (stateAfter === 'paused') {
      return this.error(
        'answer-pending',
        'not-resumable',
        `run ${runId} was not resumable (state ${stateBefore})`,
      );
    }

    return {
      ok: true,
      command: 'answer-pending',
      run: this.snapshot(entry),
      lastSeq: this.seq,
    };
  }

  private cancel(runId: string): AgentHostCommandResponse {
    const entry = this.runs.get(runId);
    if (!entry) {
      return this.error('cancel', 'not-found', `run ${runId} not found`);
    }

    entry.run.cancel();
    entry.updatedAt = this.now();
    return {
      ok: true,
      command: 'cancel',
      run: this.snapshot(entry),
      lastSeq: this.seq,
    };
  }

  /** Workflow-engine redesign — delivery is the SOLE done-signal. The server's
   *  deliverable route relays `complete-run` here so the host's own AgentRun
   *  transitions running→completed (no-op if not running). The `terminal` wiring
   *  then emits `run-terminal`, which the server finalizes + resolves the
   *  dispatch `done` on. This is the ONLY completion path — no in-process. */
  private completeRun(runId: string, result?: string): AgentHostCommandResponse {
    const entry = this.runs.get(runId);
    if (!entry) {
      return this.error('complete-run', 'not-found', `run ${runId} not found`);
    }

    entry.run.complete(result);
    entry.updatedAt = this.now();
    return {
      ok: true,
      command: 'complete-run',
      run: this.snapshot(entry),
      lastSeq: this.seq,
    };
  }

  private notifyMcpHandshake(ccSessionId: string): AgentHostCommandResponse {
    const runId = this.ccSessionIndex.get(ccSessionId);
    const entry = runId ? this.runs.get(runId) : undefined;
    if (entry) {
      entry.run.notifyMcpHandshake();
      return {
        ok: true,
        command: 'notify-mcp-handshake',
        lastSeq: this.seq,
      };
    }

    return this.error(
      'notify-mcp-handshake',
      'not-found',
      `active cc session ${ccSessionId} not found`,
    );
  }

  private shutdown(mode: 'host-exit' | 'cancel-runs'): AgentHostCommandResponse {
    this.shuttingDown = true;
    if (mode === 'cancel-runs') {
      for (const entry of this.runs.values()) {
        if (!entry.run.isTerminal()) entry.run.cancel();
      }
    }
    return {
      ok: true,
      command: 'shutdown',
      lastSeq: this.seq,
    };
  }

  private wireRun(entry: HostRunEntry): void {
    entry.run.on('state', () => {
      entry.updatedAt = this.now();
      this.emitRunState(entry);
    });
    entry.run.on(
      'jsonl-event',
      (event: unknown, meta?: { sourceCursor?: number }) => {
        // G7 — replay meta rides the wire so the server can re-persist its
        // jsonl-events.jsonl replay log from the one host stream.
        this.appendEvent({
          type: 'run-jsonl',
          runId: entry.request.runId,
          event,
          cursor: meta?.sourceCursor,
          kind: extractEventKind(event),
          source: 'claude-jsonl',
        });
      },
    );
    // G1 — turn-state changes refresh the snapshot stream (the chat
    // send-queue drains on 'ready').
    entry.run.on('turn-state', () => {
      entry.updatedAt = this.now();
      this.emitRunState(entry);
    });
    entry.run.on('chunk', (text: string) => {
      this.appendEvent({
        type: 'run-chunk',
        runId: entry.request.runId,
        text,
      });
    });
    entry.run.on(
      'terminal',
      (terminal: {
        status: 'completed' | 'failed' | 'cancelled';
        cause?: string;
        result?: string;
      }) => {
        entry.updatedAt = this.now();
        entry.terminalResult = toTerminalResult(terminal);
        this.ccSessionIndex.delete(entry.request.ccSessionId);
        this.appendEvent({
          type: 'run-terminal',
          run: this.snapshot(entry),
        });
      },
    );
  }

  private emitRunState(entry: HostRunEntry): void {
    this.appendEvent({
      type: 'run-state',
      run: this.snapshot(entry),
    });
  }

  private listRunSnapshots(): AgentHostRunSnapshot[] {
    return Array.from(this.runs.values(), (entry) => this.snapshot(entry));
  }

  private snapshot(entry: HostRunEntry): AgentHostRunSnapshot {
    const record = entry.run.getRecord();
    return {
      runId: entry.request.runId,
      projectId: entry.request.projectId,
      dispatcherSessionId: entry.request.dispatcherSessionId,
      ccSessionId: record.ccProviderSessionId,
      podName: record.podName,
      worktreeDir: entry.request.worktreePath,
      state: record.state,
      policy: record.policy,
      turnState: record.turnState,
      jsonlPath: entry.run.getJsonlPath(),
      transcriptPath: entry.request.transcriptPath ?? null,
      queuedAt: record.queuedAt ?? record.createdAt,
      spawnedAt: record.spawningAt ?? null,
      readyAt: record.readyAt ?? null,
      updatedAt: entry.updatedAt,
      terminalAt: record.terminalAt ?? null,
      terminalResult: entry.terminalResult,
    };
  }

  private toAgentRunInput(request: HostRunRequest): AgentRunInput {
    return {
      agentRunId: request.runId,
      ccProviderSessionId: request.ccSessionId,
      podDefinition: request.podDefinition,
      worktreePath: request.worktreePath,
      env: request.env,
      policy: request.policy,
      initialInput: request.initialInput,
      // Slice 2 — a plain start-run may carry mode:'resume' (the orchestrator
      // resumes its own conversation without a continuation lineage).
      mode: isResumeRequest(request) ? 'resume' : (request.mode ?? 'fresh'),
      continues: isResumeRequest(request) ? request.continues : undefined,
      mcpConfigPath: request.mcpConfigPath,
      settingsPath: request.settingsPath,
      settingSources: request.settingSources,
      pluginDirs: request.pluginDirs,
      transcriptPath: request.transcriptPath,
      // Server-authoritative path (computed with the server's normalized env).
      // Thread it straight through instead of letting AgentRun/low-level-spawn
      // recompute from the host's own env — the recompute is the divergence bug.
      jsonlPath: request.jsonlPath,
      jsonlStartLine: request.jsonlStartLine,
      // Slice 2 — orchestrator spawn shaping (workers omit all of these).
      envOverrides: request.envOverrides,
      model: request.model,
      requireReadySignal: request.requireReadySignal,
      requireMcpHandshake: request.requireMcpHandshake,
      cols: request.cols,
      rows: request.rows,
      spawnStuckMs: request.timeouts?.spawnStuckMs,
      wallClockMs: request.timeouts?.wallClockMs,
      handshakeTimeoutMs: request.timeouts?.handshakeTimeoutMs,
      readyTimeoutMs: request.timeouts?.readyTimeoutMs,
      cancelGraceMs: request.timeouts?.cancelGraceMs,
    };
  }

  private appendEvent(event: AgentHostEventPayload): AgentHostEvent {
    const next = { seq: ++this.seq, ...event } as AgentHostEvent;
    this.events.push(next);
    while (this.events.length > this.eventBufferLimit) {
      this.events.shift();
    }
    this.emit('event', next);
    return next;
  }

  private error(
    command: AgentHostCommand['type'],
    code: AgentHostCommandErrorCode,
    error: string,
  ): AgentHostCommandResponse {
    return {
      ok: false,
      command,
      code,
      error,
      lastSeq: this.seq,
    };
  }
}

/** G7 — mirror the event's `kind` onto the wire envelope so the server-side
 *  replay writer doesn't have to parse `unknown`. */
function extractEventKind(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const kind = (event as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : undefined;
}

function isResumeRequest(
  request: HostRunRequest,
): request is AgentHostResumeRunRequest {
  return (request as AgentHostResumeRunRequest).mode === 'resume';
}

function toTerminalResult(terminal: {
  status: 'completed' | 'failed' | 'cancelled';
  cause?: string;
  result?: string;
}): AgentHostTerminalResult {
  return {
    status: terminal.status,
    result: terminal.result ?? null,
    failureCause: terminal.cause ?? null,
    failureReason: terminal.status === 'failed' ? (terminal.cause ?? null) : null,
  };
}
