import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

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
  type AgentHostWorkflowSubagentRequest,
  type AgentHostWorkflowSubagentSnapshot,
  type AgentRunInput,
  type LowLevelSpawnInput,
  type SpawnFactory,
  type SpawnLike,
  spawnSubagent,
  type SubagentSpawnHandle,
  type SubagentSpawnResult,
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
  workflowSpawnFactory?: (input: LowLevelSpawnInput) => SpawnLike;
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

interface WorkflowSubagentEntry {
  request: AgentHostWorkflowSubagentRequest;
  handle: SubagentSpawnHandle | null;
  ccSessionId: string | null;
  notifyMcpHandshake: (() => void) | null;
  state: AgentHostWorkflowSubagentSnapshot['state'];
  startedAt: number;
  updatedAt: number;
  terminalAt: number | null;
  terminalResult?: SubagentSpawnResult;
}

export class AgentHostService extends EventEmitter {
  private readonly identity: AgentHostIdentity;
  private readonly registry: AgentRunRegistry;
  private readonly spawnFactory?: SpawnFactory;
  private readonly workflowSpawnFactory?: (input: LowLevelSpawnInput) => SpawnLike;
  private readonly now: () => number;
  private readonly eventBufferLimit: number;
  private readonly runs = new Map<string, HostRunEntry>();
  private readonly ccSessionIndex = new Map<string, string>();
  private readonly workflowSubagents = new Map<string, WorkflowSubagentEntry>();
  private readonly workflowCcSessionIndex = new Map<string, string>();
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
    this.workflowSpawnFactory = options.workflowSpawnFactory;
    this.eventBufferLimit =
      options.eventBufferLimit ?? DEFAULT_EVENT_BUFFER_LIMIT;
  }

  getIdentity(): AgentHostIdentity {
    return { ...this.identity };
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
      case 'start-workflow-subagent':
        return this.startWorkflowSubagent(command.request);
      case 'send':
        return this.send(command.runId, command.text);
      case 'mark-paused':
        return this.markPaused(command.runId, command.askId);
      case 'answer-pending':
        return this.answerPending(command.runId, command.text);
      case 'cancel':
        return this.cancel(command.runId);
      case 'cancel-workflow-subagent':
        return this.cancelWorkflowSubagent(command.pcSessionId, command.reason);
      case 'notify-mcp-handshake':
        return this.notifyMcpHandshake(command.ccSessionId);
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

  private startWorkflowSubagent(
    request: AgentHostWorkflowSubagentRequest,
  ): AgentHostCommandResponse {
    if (this.shuttingDown) {
      return this.error(
        'start-workflow-subagent',
        'host-shutting-down',
        'host is shutting down',
      );
    }
    if (this.workflowSubagents.has(request.pcSessionId)) {
      return this.error(
        'start-workflow-subagent',
        'run-exists',
        `workflow subagent ${request.pcSessionId} already exists`,
      );
    }

    const entry: WorkflowSubagentEntry = {
      request,
      handle: null,
      ccSessionId: null,
      notifyMcpHandshake: null,
      state: 'running',
      startedAt: this.now(),
      updatedAt: this.now(),
      terminalAt: null,
    };
    this.workflowSubagents.set(request.pcSessionId, entry);

    const handle = spawnSubagent(request, {
      ...(this.workflowSpawnFactory
        ? { createLowLevelSpawn: this.workflowSpawnFactory }
        : {}),
      registerHandshakeListener: (ccSessionId, notify) => {
        entry.ccSessionId = ccSessionId;
        entry.notifyMcpHandshake = notify;
        entry.updatedAt = this.now();
        this.workflowCcSessionIndex.set(ccSessionId, request.pcSessionId);
        this.emitWorkflowSubagentState(entry);
        return () => {
          if (this.workflowCcSessionIndex.get(ccSessionId) === request.pcSessionId) {
            this.workflowCcSessionIndex.delete(ccSessionId);
          }
          if (entry.notifyMcpHandshake === notify) {
            entry.notifyMcpHandshake = null;
          }
        };
      },
    });
    entry.handle = handle;
    entry.updatedAt = this.now();
    this.emitWorkflowSubagentState(entry);
    void handle.done.then((result) => this.finishWorkflowSubagent(entry, result));

    return {
      ok: true,
      command: 'start-workflow-subagent',
      workflowSubagent: this.workflowSnapshot(entry),
      lastSeq: this.seq,
    };
  }

  private cancelWorkflowSubagent(
    pcSessionId: string,
    reason?: string,
  ): AgentHostCommandResponse {
    const entry = this.workflowSubagents.get(pcSessionId);
    if (!entry) {
      return this.error(
        'cancel-workflow-subagent',
        'not-found',
        `workflow subagent ${pcSessionId} not found`,
      );
    }

    entry.handle?.kill(reason ?? 'cancelled by host command');
    entry.updatedAt = this.now();
    return {
      ok: true,
      command: 'cancel-workflow-subagent',
      workflowSubagent: this.workflowSnapshot(entry),
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

    const workflowPcSessionId = this.workflowCcSessionIndex.get(ccSessionId);
    const workflowEntry = workflowPcSessionId
      ? this.workflowSubagents.get(workflowPcSessionId)
      : undefined;
    if (workflowEntry?.notifyMcpHandshake) {
      const notify = workflowEntry.notifyMcpHandshake;
      workflowEntry.notifyMcpHandshake = null;
      this.workflowCcSessionIndex.delete(ccSessionId);
      notify();
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
      for (const entry of this.workflowSubagents.values()) {
        entry.handle?.kill('host is shutting down');
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
    entry.run.on('jsonl-event', (event: unknown) => {
      this.appendEvent({
        type: 'run-jsonl',
        runId: entry.request.runId,
        event,
      });
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

  private emitWorkflowSubagentState(entry: WorkflowSubagentEntry): void {
    this.appendEvent({
      type: 'workflow-subagent-state',
      workflowSubagent: this.workflowSnapshot(entry),
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

  private workflowSnapshot(
    entry: WorkflowSubagentEntry,
  ): AgentHostWorkflowSubagentSnapshot {
    return {
      pcSessionId: entry.request.pcSessionId,
      ccSessionId: entry.ccSessionId,
      agentName: entry.request.agentName,
      worktreeDir: entry.request.worktreeDir,
      state: entry.state,
      transcriptPath:
        entry.handle?.transcriptPath() ??
        resolve(entry.request.sessionDataDir, 'transcript.log'),
      jsonlPath: entry.handle?.jsonlPath() ?? null,
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      terminalAt: entry.terminalAt,
      terminalResult: entry.terminalResult,
    };
  }

  private finishWorkflowSubagent(
    entry: WorkflowSubagentEntry,
    result: SubagentSpawnResult,
  ): void {
    entry.terminalResult = result;
    entry.state = workflowStateForResult(result);
    entry.updatedAt = this.now();
    entry.terminalAt = entry.updatedAt;
    if (entry.ccSessionId) {
      this.workflowCcSessionIndex.delete(entry.ccSessionId);
    }
    entry.notifyMcpHandshake = null;
    this.appendEvent({
      type: 'workflow-subagent-terminal',
      workflowSubagent: this.workflowSnapshot(entry),
    });
  }

  private toAgentRunInput(request: HostRunRequest): AgentRunInput {
    return {
      agentRunId: request.runId,
      ccProviderSessionId: request.ccSessionId,
      podDefinition: request.podDefinition,
      worktreePath: request.worktreePath,
      env: request.env,
      initialInput: request.initialInput,
      mode: isResumeRequest(request) ? 'resume' : 'fresh',
      continues: isResumeRequest(request) ? request.continues : undefined,
      mcpConfigPath: request.mcpConfigPath,
      settingsPath: request.settingsPath,
      settingSources: request.settingSources,
      pluginDirs: request.pluginDirs,
      transcriptPath: request.transcriptPath,
      spawnStuckMs: request.timeouts?.spawnStuckMs,
      idleMs: request.timeouts?.idleMs,
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

function workflowStateForResult(
  result: SubagentSpawnResult,
): AgentHostWorkflowSubagentSnapshot['state'] {
  if (result.kind === 'success') return 'completed';
  return result.cause === 'killed' ? 'cancelled' : 'failed';
}
