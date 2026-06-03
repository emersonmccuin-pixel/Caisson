// InteractiveSession — long-running session lifecycle wrapper.
//
// Orchestrator, agent-designer modal, future interview surfaces — anywhere
// a human types input and the model responds across many turns. Compare
// to AgentRun (dispatched, one-shot, cap-bound, pause-able).
//
// State machine per design §4.2:
//
//   stopped → spawning → ready ⇌ busy → exited | failed
//
// (ready ↔ busy cycles every turn: send() → busy; jsonl-turn-end → ready.)
//
// Differences vs AgentRun:
//   - No queue, no cap (one orchestrator + at most a couple interview
//     specialists; capping them would block the user mid-flow).
//   - No AgentRunRecord persistence concern — orchestrator's
//     OrchestratorSession row covers identity; transient sessions write
//     nothing persistent beyond on-disk JSONL.
//   - No pause primitive. `pc_ask_orchestrator` / `pc_ask_user` are
//     dispatched-only tools. AskUserQuestion goes through a separate
//     ask-intercept hook, not this wrapper.
//   - Resume semantics are session-level (Section 5++), via
//     mode='resume' on construction. There's no "answer-resume" flow here.

import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JsonlEvent, JsonlEventMeta } from './jsonl-tailer.ts';
import {
  LowLevelSpawn,
  type LowLevelSpawnInput,
  type PodDescriptor,
  type SpawnState,
} from './low-level-spawn.ts';
import type { ReadyTimestamps } from './ready-gate.ts';
import type { SendResult } from './send-protocol.ts';
import type { SpawnFactory, SpawnLike } from './agent-run.ts';
import type { JsonlReplayMeta } from './pty-session.ts';

export type InteractiveSessionState =
  | 'stopped'
  | 'spawning'
  | 'ready'
  | 'busy'
  | 'exited'
  | 'failed';

export interface InteractiveSessionInput {
  pcSessionId: string;
  ccProviderSessionId: string;
  podDefinition: PodDescriptor;
  worktreePath: string;
  env: Record<string, string | undefined>;
  /** Optional post-scrub env overrides passed to LowLevelSpawn. */
  envOverrides?: Record<string, string | undefined>;
  /** 'fresh' = mint a new conversation; 'resume' = continue an existing
   *  on-disk session by --resume <uuid>. */
  mode?: 'fresh' | 'resume';
  /** Body to send as the first user turn after the gate opens. Optional —
   *  many interactive sessions start idle and wait for the user to type. */
  initialInput?: string;
  mcpConfigPath?: string;
  settingsPath?: string;
  settingSources?: string;
  pluginDirs?: readonly string[];
  claudeExe?: string;
  transcriptPath?: string;
  /** Persisted provider JSONL path. Pass this for resumes so the wrapper
   *  attaches to the transcript that belongs to the PC session row. */
  jsonlPath?: string;
  /** Source cursor to resume tailing from. */
  jsonlStartLine?: number;
  /** PC-owned normalized replay log. When supplied, every JSONL event is
   *  appended before it is emitted. */
  replayEventsPath?: string;
  model?: string;
  remoteControl?: boolean;
  requireReadySignal?: boolean;
  handshakeTimeoutMs?: number;
  requireMcpHandshake?: boolean;
  readyTimeoutMs?: number;
  /** Wrapper-level spawn timeout, separate from LowLevelSpawn's ready gate. */
  spawnTimeoutMs?: number;
  /** Number of spawn attempts before the wrapper enters failed. Default 1. */
  maxSpawnAttempts?: number;
  /** Delay before a retry attempt. Default 1s. */
  retryBackoffMs?: number;
  /** PTY dimensions. Defaults live in LowLevelSpawn. */
  cols?: number;
  rows?: number;
}

export interface InteractiveSessionDeps {
  /** Default = production factory: `(input) => new LowLevelSpawn(input)`. */
  spawnFactory?: SpawnFactory;
  /** Default = `Date.now`. */
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  attemptIdFactory?: (attempt: number, now: number) => string;
}

const defaultSpawnFactory: SpawnFactory = (input: LowLevelSpawnInput) =>
  new LowLevelSpawn(input);

export class InteractiveSession extends EventEmitter {
  private state: InteractiveSessionState = 'stopped';
  private spawn: SpawnLike | null = null;
  private started = false;
  private closing = false;
  private readonly deps: Required<InteractiveSessionDeps>;
  private timestamps: {
    stoppedAt?: number;
    spawningAt?: number;
    readyAt?: number;
    exitedAt?: number;
    failedAt?: number;
  } = {};
  private attempt = 0;
  private spawnAttemptId: string | null = null;
  private failureReason: string | null = null;
  private nextRetryAt: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private spawnTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private nextReplaySeq = 1;

  constructor(
    private readonly input: InteractiveSessionInput,
    deps: InteractiveSessionDeps = {},
  ) {
    super();
    this.deps = {
      spawnFactory: deps.spawnFactory ?? defaultSpawnFactory,
      now: deps.now ?? (() => Date.now()),
      setTimeout: deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms)),
      clearTimeout: deps.clearTimeout ?? ((handle) => clearTimeout(handle)),
      attemptIdFactory:
        deps.attemptIdFactory ??
        ((attempt, now) => `${this.input.pcSessionId}:${attempt}:${now}`),
    };
    this.timestamps.stoppedAt = this.deps.now();
    if (this.input.replayEventsPath) {
      this.nextReplaySeq = nextReplaySeqFromFile(this.input.replayEventsPath);
    }
  }

  /** Begin the lifecycle. Idempotent — throws on second call. */
  start(): void {
    if (this.started) throw new Error('InteractiveSession.start() called twice');
    this.started = true;
    this.startAttempt();
  }

  /** Send body to the running session. Only valid in 'ready' / 'busy'.
   *  Returns the echo-ack result from the underlying spawn. */
  async send(body: string): Promise<SendResult> {
    if (!this.spawn) throw new Error('InteractiveSession: send before start');
    if (this.state === 'exited' || this.state === 'failed') return 'exited';
    if (this.state === 'spawning') {
      throw new Error('InteractiveSession: send before ready');
    }
    if (this.state === 'stopped') {
      throw new Error('InteractiveSession: send before start');
    }
    const result = await this.spawn.send(body);
    if (result === 'ok' && this.state === 'ready') {
      this.setState('busy');
    }
    return result;
  }

  /** Raw terminal input. Bypasses chat send queue, bracketed paste, prompt
   *  history, echo ack, and ready/busy accounting. */
  writeRaw(bytes: string): boolean {
    if (!this.spawn) return false;
    if (this.state === 'exited' || this.state === 'failed' || this.state === 'stopped') {
      return false;
    }
    return this.spawn.writeRaw?.(bytes) ?? false;
  }

  /** Send escape — CC's stop-streaming key. */
  interrupt(): void {
    this.spawn?.interrupt();
  }

  resize(cols: number, rows: number): void {
    try {
      this.spawn?.resize?.(cols, rows);
    } catch {
      /* The PTY may have exited between state check and resize. */
    }
  }

  /** Close the session — kill the child and transition to exited.
   *  Idempotent. */
  close(): void {
    if (this.state === 'exited' || this.closing) return;
    this.closing = true;
    this.clearRetryTimer();
    this.clearSpawnTimeout();
    try {
      this.spawn?.kill();
    } catch {
      /* already dead */
    }
    // onSpawnExit will land via spawn's 'exit' event and call toExited.
    // Defensive: if the spawn never wired (e.g. closed before start completed)
    // transition synchronously.
    if (!this.spawn || this.state === 'failed' || this.state === 'stopped') this.toExited();
  }

  /** Compatibility alias for legacy PtySession consumers. */
  kill(): void {
    this.close();
  }

  /** Pass-through for the /api/internal/mcp-handshake route. */
  notifyMcpHandshake(): void {
    this.spawn?.notifyMcpHandshake();
  }

  getState(): InteractiveSessionState {
    return this.state;
  }

  getJsonlPath(): string | null {
    return this.spawn?.getJsonlPath() ?? null;
  }

  getSnapshot(): {
    state: InteractiveSessionState;
    spawnAttempt: number;
    spawnAttemptId: string | null;
    lastReadyAt: number | null;
    nextRetryAt: number | null;
    failureReason: string | null;
  } {
    return {
      state: this.state,
      spawnAttempt: this.attempt,
      spawnAttemptId: this.spawnAttemptId,
      lastReadyAt: this.timestamps.readyAt ?? null,
      nextRetryAt: this.nextRetryAt,
      failureReason: this.failureReason,
    };
  }

  // -- internals ------------------------------------------------------

  private startAttempt(): void {
    if (this.closing) return;
    const attempt = this.attempt + 1;
    this.attempt = attempt;
    const now = this.deps.now();
    this.spawnAttemptId = this.deps.attemptIdFactory(attempt, now);
    this.failureReason = null;
    this.nextRetryAt = null;
    this.timestamps.spawningAt = now;
    this.setState('spawning');

    const mode: 'fresh' | 'resume' = this.input.mode ?? 'fresh';
    const llsInput: LowLevelSpawnInput = {
      podDefinition: this.input.podDefinition,
      worktreePath: this.input.worktreePath,
      env: this.input.env,
      envOverrides: this.input.envOverrides,
      ccProviderSessionId: this.input.ccProviderSessionId,
      mode,
      jsonlPath: this.input.jsonlPath,
      jsonlStartLine: this.input.jsonlStartLine,
      mcpConfigPath: this.input.mcpConfigPath,
      settingsPath: this.input.settingsPath,
      settingSources: this.input.settingSources,
      pluginDirs: this.input.pluginDirs,
      claudeExe: this.input.claudeExe,
      transcriptPath: this.input.transcriptPath,
      model: this.input.model,
      remoteControl: this.input.remoteControl,
      requireReadySignal: this.input.requireReadySignal,
      handshakeTimeoutMs: this.input.handshakeTimeoutMs,
      requireMcpHandshake: this.input.requireMcpHandshake,
      readyTimeoutMs: this.input.readyTimeoutMs,
      cols: this.input.cols,
      rows: this.input.rows,
    };
    const spawn = this.deps.spawnFactory(llsInput);
    this.spawn = spawn;

    spawn.on('jsonl-event', (ev: JsonlEvent, meta?: JsonlEventMeta) =>
      this.onJsonlEvent(ev, meta),
    );
    spawn.on('exit', (code: number | null, signal: number | null) => {
      this.emit('exit', code, signal);
      if (this.state === 'spawning' || this.state === 'failed') return;
      this.toExited();
    });
    spawn.on('state', (s: SpawnState) => this.emit('spawn-state', s));
    spawn.on('chunk', (text: string) => this.emit('chunk', text));
    spawn.on('raw', (text: string) => this.emit('raw', text));
    spawn.on('ready', (ts: ReadyTimestamps) => this.emit('ready', ts));

    spawn.start();
    const jsonlPath = spawn.getJsonlPath();
    if (jsonlPath) this.emit('jsonl-path-resolved', jsonlPath);
    this.armSpawnTimeout(attempt);

    spawn
      .awaitReady()
      .then(() => this.onAttemptReady(attempt, spawn))
      .catch((err) => this.onAttemptFailed(attempt, err));
  }

  private async onAttemptReady(attempt: number, spawn: SpawnLike): Promise<void> {
    if (attempt !== this.attempt || this.spawn !== spawn) return;
    this.clearSpawnTimeout();
    this.timestamps.readyAt = this.deps.now();
    if (this.closing || this.state === 'exited') return;
    this.setState('ready');

    if (this.input.initialInput && this.input.initialInput.length > 0) {
      try {
        const result = await spawn.send(this.input.initialInput);
        if (result === 'ok' && this.state === 'ready') {
          this.setState('busy');
        }
      } catch (err) {
        this.emit('error', err);
      }
    }
  }

  private onAttemptFailed(attempt: number, err: unknown): void {
    if (attempt !== this.attempt) return;
    if (this.retryTimer || this.state === 'failed' || this.state === 'exited') return;
    this.clearSpawnTimeout();
    const message = stringifyError(err);
    this.failureReason = message;
    if (!this.closing) this.emit('error', err);

    try {
      this.spawn?.kill();
    } catch {
      /* already gone */
    }

    const maxAttempts = Math.max(1, this.input.maxSpawnAttempts ?? 1);
    if (!this.closing && attempt < maxAttempts) {
      const delay = Math.max(0, this.input.retryBackoffMs ?? 1000);
      this.nextRetryAt = this.deps.now() + delay;
      this.emit('retry-scheduled', {
        attempt,
        nextAttempt: attempt + 1,
        at: this.nextRetryAt,
        reason: message,
      });
      this.retryTimer = this.deps.setTimeout(() => {
        this.retryTimer = null;
        this.startAttempt();
      }, delay);
      this.unrefTimer(this.retryTimer);
      return;
    }

    if (this.closing) {
      this.toExited();
    } else {
      this.toFailed(message);
    }
  }

  private onJsonlEvent(ev: JsonlEvent, meta?: JsonlEventMeta): void {
    const replay = this.persistJsonlEvent(ev, meta);
    this.emit('jsonl-event', ev, replay);
    const jsonlPath = this.spawn?.getJsonlPath();
    if (jsonlPath && meta?.sourceCursor !== undefined) {
      this.emit('jsonl-cursor-tick', jsonlPath, meta.sourceCursor);
    }
    if (ev.kind === 'jsonl-turn-end' && this.state === 'busy') {
      // Turn cycle complete; session goes back to ready awaiting next user input.
      this.setState('ready');
      this.emit('turn-end');
    }
  }

  private setState(next: InteractiveSessionState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.emit('state', next, prev);
  }

  private toExited(): void {
    if (this.state === 'exited') return;
    this.clearRetryTimer();
    this.clearSpawnTimeout();
    this.timestamps.exitedAt = this.deps.now();
    this.setState('exited');
    this.emit('exited');
  }

  private toFailed(reason: string): void {
    if (this.state === 'failed') return;
    this.clearRetryTimer();
    this.clearSpawnTimeout();
    this.failureReason = reason;
    this.timestamps.failedAt = this.deps.now();
    this.setState('failed');
    this.emit('failed', reason);
  }

  private armSpawnTimeout(attempt: number): void {
    this.clearSpawnTimeout();
    const timeoutMs = this.input.spawnTimeoutMs;
    if (timeoutMs === undefined || timeoutMs <= 0) return;
    this.spawnTimeoutTimer = this.deps.setTimeout(() => {
      this.spawnTimeoutTimer = null;
      this.onAttemptFailed(
        attempt,
        new Error(`InteractiveSession: spawn attempt timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    this.unrefTimer(this.spawnTimeoutTimer);
  }

  private clearSpawnTimeout(): void {
    if (!this.spawnTimeoutTimer) return;
    this.deps.clearTimeout(this.spawnTimeoutTimer);
    this.spawnTimeoutTimer = null;
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    this.deps.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private persistJsonlEvent(ev: JsonlEvent, meta?: JsonlEventMeta): JsonlReplayMeta | undefined {
    if (!this.input.replayEventsPath) return undefined;
    const seq = this.nextReplaySeq++;
    const replay: JsonlReplayMeta = {
      id: `${this.input.pcSessionId}:${seq}`,
      sessionId: this.input.pcSessionId,
      seq,
      kind: ev.kind,
      source: {
        kind: 'claude-jsonl',
        cursor: meta?.sourceCursor ?? null,
      },
    };
    try {
      mkdirSync(dirname(this.input.replayEventsPath), { recursive: true });
      appendFileSync(
        this.input.replayEventsPath,
        JSON.stringify({
          ...replay,
          type: 'jsonl',
          event: ev,
        }) + '\n',
      );
    } catch (err) {
      this.emit('jsonl-persist-error', err);
    }
    return replay;
  }

  private unrefTimer(timer: ReturnType<typeof setTimeout> | null): void {
    (timer as { unref?: () => void } | null)?.unref?.();
  }
}

function nextReplaySeqFromFile(filePath: string): number {
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    let validCount = 0;
    let maxSeq = 0;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const row = parsed as { type?: unknown; event?: unknown; seq?: unknown };
      if (row.type !== 'jsonl' || !row.event || typeof row.event !== 'object') continue;
      validCount++;
      if (typeof row.seq === 'number' && Number.isSafeInteger(row.seq) && row.seq > maxSeq) {
        maxSeq = row.seq;
      }
    }
    return Math.max(validCount, maxSeq) + 1;
  } catch {
    return 1;
  }
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
