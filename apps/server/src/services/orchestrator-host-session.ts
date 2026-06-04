// OrchestratorHostSession — Step-4 Slice 2: the orchestrator chat as an
// Engine-owned run.
//
// Presents the EXACT port + event surface the old InteractiveSession exposed
// (getState/send/interrupt/writeRaw/resize/kill/notifyMcpHandshake +
// raw/state/turn-end/jsonl-event/failed/exit events), but owns NO process:
// it issues `start-run {policy: 'persistent-interactive'}` to the agent host
// and translates the host's event stream back into the chat wiring's
// vocabulary. ONE owner of every Claude process (north-star §4); the server
// keeps owning ONLY the per-session replay log + the WS fan-out.
//
// Survival behaviors this class owns (the reconciler never sees this run —
// it has no agent_runs row, deliberately):
//   - API restart: at start() it checks the host roster for a live run on the
//     same CC session id and ADOPTS it instead of double-spawning (the host
//     would reject the duplicate ccSessionId anyway — adopt is the one path).
//   - Host death (G5/FD-18): on host-respawn (new hostId) or a health dip,
//     state → 'spawning' ("Claude is loading", sends queue); when the new
//     host is up the chat re-dispatches itself with `--resume` and the full
//     conversation history.
//   - Replay continuity (G7): every run-jsonl wire event is re-persisted into
//     the same per-session jsonl-events.jsonl the UI replays from, with
//     source-cursor dedup so a host-event-buffer replay after an API restart
//     can't double-write history.
//   - Terminal view: 'raw' is fed by tailing the transcript file the host's
//     spawn writes (shared disk — scope-doc decision 6, no new protocol).

import { EventEmitter } from 'node:events';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AgentHostCommand,
  AgentHostCommandResponse,
  AgentHostEvent,
  AgentHostRunSnapshot,
  AgentHostStartRunRequest,
  JsonlReplayMeta,
} from '@pc/runtime';
import type { ULID } from '@pc/domain';

import type { HostHealth } from './host-connection.ts';

export type OrchestratorHostSessionState =
  | 'spawning'
  | 'ready'
  | 'busy'
  | 'exited'
  | 'failed';

/** The slice of HostConnection this adapter needs (HostConnection satisfies
 *  it structurally). `onHealthChange` is optional so tests can drive
 *  recovery purely through events. */
export interface OrchestratorHostPort {
  sendCommand(cmd: AgentHostCommand): Promise<AgentHostCommandResponse>;
  listRuns(): readonly AgentHostRunSnapshot[];
  refreshRuns(): Promise<readonly AgentHostRunSnapshot[]>;
  onEvent(listener: (e: AgentHostEvent) => void): () => void;
  onHealthChange?(listener: (h: HostHealth) => void): () => void;
}

/** Narrow the loose AgentHostReattachClient seam (sendCommand may be sync in
 *  test fakes; onEvent/refreshRuns optional) to the full port the chat needs.
 *  Production passes the HostConnection, which always qualifies. */
export function asOrchestratorHostPort(client: unknown): OrchestratorHostPort | null {
  if (!client || typeof client !== 'object') return null;
  const cand = client as Partial<Record<keyof OrchestratorHostPort, unknown>>;
  if (
    typeof cand.sendCommand !== 'function' ||
    typeof cand.listRuns !== 'function' ||
    typeof cand.refreshRuns !== 'function' ||
    typeof cand.onEvent !== 'function'
  ) {
    return null;
  }
  return client as OrchestratorHostPort;
}

export interface OrchestratorHostSessionInput {
  pcSessionId: string;
  /** CC provider session UUID — the conversation identity (`--session-id` /
   *  `--resume`). Also the host's ccSessionIndex key. */
  providerSessionId: string;
  projectId: ULID;
  podDefinition: { name: string; logicalName?: string };
  worktreePath: string;
  env: Record<string, string | undefined>;
  envOverrides?: Record<string, string | undefined>;
  mode: 'fresh' | 'resume';
  /** Server-authoritative CC JSONL path (computed with the server's env). */
  jsonlPath: string;
  jsonlStartLine?: number;
  mcpConfigPath?: string;
  settingsPath?: string;
  settingSources?: string;
  pluginDirs?: readonly string[];
  transcriptPath: string;
  /** PC-owned normalized replay log (jsonl-events.jsonl in the session dir). */
  replayEventsPath: string;
  model?: string;
  requireReadySignal?: boolean;
  requireMcpHandshake?: boolean;
  cols?: number;
  rows?: number;
  /** Wait for the PREVIOUS chat session's host-run to settle before starting
   *  (the host rejects a second run on the same ccSessionId; cancel is
   *  asynchronous). Bounded internally — a hung predecessor can't wedge. */
  awaitBefore?: Promise<unknown>;
  /** Pod-prep cleanup, called exactly once at terminal. */
  onCleanup?: () => void;
}

export interface OrchestratorHostSessionDeps {
  hostClient: OrchestratorHostPort;
  now?: () => number;
  /** Transcript tail poll interval. */
  transcriptPollMs?: number;
  /** Cap on waiting for the predecessor run to settle. */
  awaitBeforeTimeoutMs?: number;
  mintRunId?: () => string;
  logger?: Pick<Console, 'error' | 'warn' | 'log'>;
}

const ORCHESTRATOR_TIMEOUTS = {
  // Cancel-grace exists to catch a late deliverable on workers; the chat has
  // none. Short grace = startNewSession/pod-edit restarts don't trade a 5s
  // ccSessionIndex hold for nothing.
  cancelGraceMs: 500,
};

export class OrchestratorHostSession extends EventEmitter {
  private state: OrchestratorHostSessionState = 'spawning';
  private runId: string | null = null;
  private started = false;
  private closing = false;
  private terminalReached = false;
  private cleanedUp = false;
  private failureReason: string | null = null;
  private lastReadyAt: number | null = null;
  private dispatchCount = 0;
  private lastHostId: string | null = null;
  private recovering = false;

  private nextReplaySeq = 1;
  private maxPersistedCursor = 0;

  private transcriptOffset = 0;
  private transcriptPoller: NodeJS.Timeout | null = null;

  private unsubEvent: (() => void) | null = null;
  private unsubHealth: (() => void) | null = null;

  /** Resolves when the host has reported terminal for this session's run (or
   *  the session failed before ever dispatching). The NEXT chat session for
   *  the same providerSessionId awaits this before start-run. */
  readonly settled: Promise<void>;
  private resolveSettled!: () => void;

  private readonly deps: Required<Pick<OrchestratorHostSessionDeps, 'now' | 'transcriptPollMs' | 'awaitBeforeTimeoutMs' | 'mintRunId' | 'logger'>> & {
    hostClient: OrchestratorHostPort;
  };

  constructor(
    private readonly input: OrchestratorHostSessionInput,
    deps: OrchestratorHostSessionDeps,
  ) {
    super();
    this.deps = {
      hostClient: deps.hostClient,
      now: deps.now ?? (() => Date.now()),
      transcriptPollMs: deps.transcriptPollMs ?? 250,
      awaitBeforeTimeoutMs: deps.awaitBeforeTimeoutMs ?? 10_000,
      mintRunId: deps.mintRunId ?? (() => randomUUID()),
      logger: deps.logger ?? console,
    };
    this.settled = new Promise<void>((res) => {
      this.resolveSettled = res;
    });
    const replayState = scanReplayFile(this.input.replayEventsPath);
    this.nextReplaySeq = replayState.nextSeq;
    this.maxPersistedCursor = replayState.maxCursor;
  }

  /** Begin the lifecycle. Idempotent — throws on second call. */
  start(): void {
    if (this.started) throw new Error('OrchestratorHostSession.start() called twice');
    this.started = true;
    // Subscribe BEFORE dispatch so no event for our (self-minted) runId can
    // land in a gap.
    this.unsubEvent = this.deps.hostClient.onEvent((e) => this.onHostEvent(e));
    this.unsubHealth =
      this.deps.hostClient.onHealthChange?.((h) => this.onHealthChange(h)) ?? null;
    this.startTranscriptTail();
    void this.runStart().catch((err) => {
      this.toFailed(`orchestrator host start failed: ${stringify(err)}`);
    });
  }

  // ── port surface (the InteractiveSession contract) ────────────────────────

  async send(body: string): Promise<string> {
    if (!this.started) throw new Error('OrchestratorHostSession: send before start');
    if (this.state === 'exited' || this.state === 'failed') return 'exited';
    if (!this.runId || this.state === 'spawning') {
      throw new Error('OrchestratorHostSession: send before ready');
    }
    try {
      const res = await this.deps.hostClient.sendCommand({
        type: 'send',
        runId: this.runId as ULID,
        text: body,
      });
      if (!res) return 'send-failed: no response from agent host';
      if (res.ok) return 'ok';
      return `send-failed: ${res.error}`;
    } catch (err) {
      return `send-failed: ${stringify(err)}`;
    }
  }

  /** Escape — CC's stop-streaming key. Non-destructive (G2). */
  interrupt(): void {
    this.fireCommand((runId) => ({ type: 'interrupt', runId }));
  }

  resize(cols: number, rows: number): void {
    this.fireCommand((runId) => ({ type: 'resize', runId, cols, rows }));
  }

  /** Raw terminal keystrokes (terminal mode). Fire-and-forget over the wire —
   *  the boolean reports local acceptance, mirroring the old PTY contract. */
  writeRaw(bytes: string): boolean {
    if (this.state === 'exited' || this.state === 'failed' || !this.runId) {
      return false;
    }
    this.fireCommand((runId) => ({ type: 'write-raw', runId, data: bytes }));
    return true;
  }

  /** End the chat process: cancel the host run. State flips to 'exited'
   *  immediately for the UI; `settled` resolves when the host confirms the
   *  terminal (the next session for this CC id awaits that). Idempotent. */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.stopTranscriptTail();
    if (this.runId && !this.terminalReached) {
      const runId = this.runId as ULID;
      void this.deps.hostClient
        .sendCommand({ type: 'cancel', runId })
        .catch(() => {
          // Host unreachable — nothing to cancel against; settle so the next
          // session isn't blocked on a host that lost the run anyway.
          this.settleTerminal();
        });
      // Belt-and-braces: a host that never reports terminal (crashed mid-
      // cancel) must not wedge the successor forever.
      const fallback = setTimeout(() => this.settleTerminal(), 8_000);
      fallback.unref?.();
    } else {
      this.settleTerminal();
    }
    if (this.state !== 'failed') this.setState('exited');
    this.emit('exit', null, null);
    this.emit('exited');
    this.cleanupOnce();
  }

  /** Compatibility alias — every legacy chat-session consumer calls kill(). */
  kill(): void {
    this.close();
  }

  notifyMcpHandshake(): void {
    void this.deps.hostClient
      .sendCommand({
        type: 'notify-mcp-handshake',
        ccSessionId: this.input.providerSessionId,
      })
      .catch(() => {
        /* informational — the ready gate self-heals via the host */
      });
  }

  getState(): OrchestratorHostSessionState {
    return this.state;
  }

  getJsonlPath(): string | null {
    return this.input.jsonlPath;
  }

  getSnapshot(): {
    state: OrchestratorHostSessionState;
    spawnAttempt: number;
    spawnAttemptId: string | null;
    lastReadyAt: number | null;
    nextRetryAt: number | null;
    failureReason: string | null;
  } {
    return {
      state: this.state,
      spawnAttempt: this.dispatchCount,
      spawnAttemptId: this.runId,
      lastReadyAt: this.lastReadyAt,
      nextRetryAt: null,
      failureReason: this.failureReason,
    };
  }

  // ── start / adopt / re-dispatch ───────────────────────────────────────────

  private async runStart(): Promise<void> {
    // Bounded wait for the predecessor's host-run to settle (cancel is async;
    // the host holds the ccSessionIndex entry until terminal).
    if (this.input.awaitBefore) {
      await Promise.race([
        this.input.awaitBefore.catch(() => {}),
        delay(this.deps.awaitBeforeTimeoutMs),
      ]);
    }
    if (this.closing) return;

    // API-restart path: the host may STILL be running this chat (persistent
    // runs survive the server). Adopt it instead of double-spawning.
    let roster: readonly AgentHostRunSnapshot[] = [];
    try {
      roster = await this.deps.hostClient.refreshRuns();
    } catch {
      // Host unreachable right now — fall through to dispatch, which will
      // produce the typed failure (or succeed if the host comes back).
    }
    const existing = roster.find(
      (run) =>
        run.ccSessionId === this.input.providerSessionId &&
        !isTerminalSnapshotState(run.state),
    );
    if (existing) {
      this.runId = existing.runId;
      this.dispatchCount += 1;
      this.emit('jsonl-path-resolved', this.input.jsonlPath);
      this.applySnapshot(existing);
      return;
    }

    await this.dispatch(this.input.mode);
  }

  /** Issue start-run. `mode: 'resume'` re-attaches CC to the conversation by
   *  UUID; used for the initial resume AND every host-death recovery. */
  private async dispatch(mode: 'fresh' | 'resume'): Promise<void> {
    if (this.closing) return;
    const runId = this.deps.mintRunId();
    this.runId = runId;
    this.dispatchCount += 1;
    this.setState('spawning');

    const request: AgentHostStartRunRequest = {
      runId: runId as ULID,
      projectId: this.input.projectId,
      dispatcherSessionId: this.input.pcSessionId,
      ccSessionId: this.input.providerSessionId,
      podDefinition: this.input.podDefinition,
      worktreePath: this.input.worktreePath,
      env: this.input.env,
      initialInput: '',
      policy: 'persistent-interactive',
      mode,
      jsonlPath: this.input.jsonlPath,
      // First dispatch honors the caller's cursor; a recovery re-dispatch
      // resumes past everything the replay log already holds so prior turns
      // don't re-emit as fresh events.
      jsonlStartLine:
        mode === 'resume'
          ? Math.max(this.input.jsonlStartLine ?? 0, this.maxPersistedCursor)
          : (this.input.jsonlStartLine ?? 0),
      envOverrides: this.input.envOverrides,
      mcpConfigPath: this.input.mcpConfigPath,
      settingsPath: this.input.settingsPath,
      settingSources: this.input.settingSources,
      pluginDirs: this.input.pluginDirs,
      transcriptPath: this.input.transcriptPath,
      model: this.input.model,
      requireReadySignal: this.input.requireReadySignal,
      // Resumes may load sessions that predate the current MCP config —
      // composer readiness is enough (mirrors the old ensurePty policy).
      requireMcpHandshake:
        mode === 'resume' ? false : this.input.requireMcpHandshake,
      cols: this.input.cols,
      rows: this.input.rows,
      timeouts: { ...ORCHESTRATOR_TIMEOUTS },
    };

    let response: AgentHostCommandResponse | void;
    try {
      response = await this.deps.hostClient.sendCommand({
        type: 'start-run',
        request,
      });
    } catch (err) {
      this.toFailed(`agent host unavailable: ${stringify(err)}`);
      return;
    }
    if (!response) {
      this.toFailed('agent host start-run returned no response');
      return;
    }
    if (!response.ok) {
      this.toFailed(`agent host start-run failed: ${response.error}`);
      return;
    }
    if (response.command !== 'start-run' || !('run' in response)) {
      this.toFailed(`agent host start-run returned ${response.command}`);
      return;
    }
    this.emit('jsonl-path-resolved', this.input.jsonlPath);
    this.applySnapshot(response.run);
  }

  // ── host event stream ─────────────────────────────────────────────────────

  private onHostEvent(event: AgentHostEvent): void {
    switch (event.type) {
      case 'host-ready': {
        const hostId = event.identity.hostId;
        const prev = this.lastHostId;
        this.lastHostId = hostId;
        if (prev !== null && prev !== hostId) {
          // The host process was replaced — every PTY it owned is gone.
          void this.recoverAfterHostChange();
        }
        return;
      }
      case 'run-state':
        if (event.run.runId !== this.runId) return;
        this.applySnapshot(event.run);
        return;
      case 'run-terminal':
        if (event.run.runId !== this.runId) return;
        this.applySnapshot(event.run);
        return;
      case 'run-jsonl': {
        if (event.runId !== this.runId) return;
        this.onRunJsonl(event);
        return;
      }
      case 'run-error':
        if (event.runId !== this.runId) return;
        this.emit('error', new Error(event.error));
        return;
      default:
        return;
    }
  }

  private onRunJsonl(event: Extract<AgentHostEvent, { type: 'run-jsonl' }>): void {
    const cursor = typeof event.cursor === 'number' ? event.cursor : null;
    // Dedup: after an API restart the host's event buffer replays recent
    // frames; anything at or below the replay log's high-water cursor is
    // already persisted AND already in the UI's replay — drop it.
    if (cursor !== null && cursor <= this.maxPersistedCursor) return;
    const replay = this.persistJsonlEvent(event.event, cursor, event.kind);
    if (cursor !== null) this.maxPersistedCursor = cursor;
    this.emit('jsonl-event', event.event, replay);
  }

  private async recoverAfterHostChange(): Promise<void> {
    if (this.recovering || this.closing || this.terminalReached) return;
    if (this.state === 'exited' || this.state === 'failed') return;
    this.recovering = true;
    try {
      // FD-18 — visible loading state; queued sends hold (queued_spawning).
      this.setState('spawning');
      let roster: readonly AgentHostRunSnapshot[] = [];
      try {
        roster = await this.deps.hostClient.refreshRuns();
      } catch {
        // New host not reachable yet — the next host-ready/health flip
        // retries; stay in 'spawning'.
        return;
      }
      const mine = roster.find(
        (run) =>
          run.ccSessionId === this.input.providerSessionId &&
          !isTerminalSnapshotState(run.state),
      );
      if (mine) {
        // Same-host stream hiccup (not a real respawn) — re-sync and move on.
        this.runId = mine.runId;
        this.applySnapshot(mine);
        return;
      }
      this.deps.logger.log(
        `[orchestrator-host-session] host changed — re-dispatching chat ${this.input.pcSessionId} with --resume`,
      );
      await this.dispatch('resume');
    } finally {
      this.recovering = false;
    }
  }

  private onHealthChange(health: HostHealth): void {
    if (this.closing || this.terminalReached) return;
    if (health.state === 'reconnecting' || health.state === 'down') {
      // The chat is unreachable — surface loading + hold the queue instead of
      // burning sends into a dead socket. Recovery rides host-ready/connected.
      if (this.state === 'ready' || this.state === 'busy') {
        this.setState('spawning');
      }
      return;
    }
    if (health.state === 'connected') {
      // Covers the connected-with-same-hostId case where no fresh host-ready
      // frame fires but our run may have been lost (e.g. host restarted while
      // we were down). recoverAfterHostChange() re-syncs either way.
      if (this.state === 'spawning' && this.runId && this.dispatchCount > 0) {
        void this.recoverAfterHostChange();
      }
    }
  }

  // ── state derivation ──────────────────────────────────────────────────────

  private applySnapshot(snapshot: AgentHostRunSnapshot): void {
    if (snapshot.state === 'failed') {
      this.markTerminalReached();
      const reason =
        snapshot.terminalResult?.failureReason ??
        snapshot.terminalResult?.failureCause ??
        'agent host reported the chat run failed';
      this.toFailed(reason);
      return;
    }
    if (snapshot.state === 'completed' || snapshot.state === 'cancelled') {
      this.markTerminalReached();
      if (!this.closing) {
        // The process ended underneath the chat (clean CC exit / external
        // cancel). Mirror the old exit flow.
        this.stopTranscriptTail();
        this.setState('exited');
        this.emit('exit', null, null);
        this.emit('exited');
        this.cleanupOnce();
      }
      return;
    }
    switch (snapshot.state) {
      case 'queued':
      case 'spawning':
        this.setState('spawning');
        return;
      case 'running': {
        if (snapshot.readyAt !== null) this.lastReadyAt = snapshot.readyAt;
        const next = snapshot.turnState === 'busy' ? 'busy' : 'ready';
        const wasBusy = this.state === 'busy';
        this.setState(next);
        if (wasBusy && next === 'ready') this.emit('turn-end');
        return;
      }
      case 'paused':
        // The orchestrator never pauses (no ask door) — defensive mapping.
        this.setState('busy');
        return;
      default:
        return;
    }
  }

  private setState(next: OrchestratorHostSessionState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.emit('state', next, prev);
  }

  private toFailed(reason: string): void {
    if (this.state === 'failed') return;
    this.failureReason = reason;
    this.stopTranscriptTail();
    this.setState('failed');
    this.emit('failed', reason);
    this.settleTerminal();
    this.cleanupOnce();
  }

  private markTerminalReached(): void {
    this.terminalReached = true;
    this.settleTerminal();
  }

  private settleTerminal(): void {
    this.resolveSettled();
  }

  private cleanupOnce(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.stopTranscriptTail();
    // Keep the event subscription alive until the host confirms terminal —
    // settled depends on it. Tear down once settled (or on a short fuse).
    void this.settled.then(() => {
      this.unsubEvent?.();
      this.unsubEvent = null;
      this.unsubHealth?.();
      this.unsubHealth = null;
    });
    try {
      this.input.onCleanup?.();
    } catch {
      /* best-effort */
    }
  }

  // ── replay log (G7 — the server re-persists from the host stream) ─────────

  private persistJsonlEvent(
    event: unknown,
    cursor: number | null,
    wireKind: string | undefined,
  ): JsonlReplayMeta {
    const seq = this.nextReplaySeq++;
    const kind =
      wireKind ??
      ((event as { kind?: unknown } | null)?.kind as JsonlReplayMeta['kind'] | undefined) ??
      'jsonl-system';
    const replay: JsonlReplayMeta = {
      id: `${this.input.pcSessionId}:${seq}`,
      sessionId: this.input.pcSessionId,
      seq,
      kind: kind as JsonlReplayMeta['kind'],
      source: { kind: 'claude-jsonl', cursor },
    };
    try {
      mkdirSync(dirname(this.input.replayEventsPath), { recursive: true });
      appendFileSync(
        this.input.replayEventsPath,
        JSON.stringify({ ...replay, type: 'jsonl', event }) + '\n',
      );
    } catch (err) {
      this.emit('jsonl-persist-error', err);
    }
    return replay;
  }

  // ── transcript tail → 'raw' (terminal view; scope-doc decision 6) ─────────

  private startTranscriptTail(): void {
    if (this.transcriptPoller) return;
    // Live view starts at EOF — history is served by the transcript REST tail.
    this.transcriptOffset = fileSize(this.input.transcriptPath);
    this.transcriptPoller = setInterval(() => this.pollTranscript(), this.deps.transcriptPollMs);
    this.transcriptPoller.unref?.();
  }

  private stopTranscriptTail(): void {
    if (!this.transcriptPoller) return;
    clearInterval(this.transcriptPoller);
    this.transcriptPoller = null;
  }

  private pollTranscript(): void {
    let size: number;
    try {
      size = fileSize(this.input.transcriptPath);
    } catch {
      return;
    }
    if (size < this.transcriptOffset) {
      // Truncated/rotated (fresh spawn rewrites the file) — restart from 0 so
      // the new process's output streams.
      this.transcriptOffset = 0;
    }
    if (size <= this.transcriptOffset) return;
    try {
      const fd = openSync(this.input.transcriptPath, 'r');
      try {
        const len = size - this.transcriptOffset;
        const buffer = Buffer.allocUnsafe(len);
        const read = readSync(fd, buffer, 0, len, this.transcriptOffset);
        this.transcriptOffset += read;
        if (read > 0) this.emit('raw', buffer.toString('utf8', 0, read));
      } finally {
        closeSync(fd);
      }
    } catch {
      /* transient read race — next poll retries */
    }
  }

  // ── misc ──────────────────────────────────────────────────────────────────

  private fireCommand(build: (runId: ULID) => AgentHostCommand): void {
    if (!this.runId || this.state === 'exited' || this.state === 'failed') return;
    const cmd = build(this.runId as ULID);
    void this.deps.hostClient.sendCommand(cmd).catch((err) => {
      this.deps.logger.warn(
        `[orchestrator-host-session] host command ${cmd.type} failed: ${stringify(err)}`,
      );
    });
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isTerminalSnapshotState(state: AgentHostRunSnapshot['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function fileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/** Resume the replay log: next seq + highest persisted source cursor. Same
 *  scan rules the old writers used (skip unparsable lines; max(count, maxSeq)
 *  + 1 keeps seq monotonic even across legacy rows without seq). */
function scanReplayFile(filePath: string): { nextSeq: number; maxCursor: number } {
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    let validCount = 0;
    let maxSeq = 0;
    let maxCursor = 0;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const row = parsed as {
        type?: unknown;
        event?: unknown;
        seq?: unknown;
        source?: { cursor?: unknown } | null;
      };
      if (row.type !== 'jsonl' || !row.event || typeof row.event !== 'object') continue;
      validCount++;
      if (typeof row.seq === 'number' && Number.isSafeInteger(row.seq) && row.seq > maxSeq) {
        maxSeq = row.seq;
      }
      const cursor = row.source?.cursor;
      if (typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor > maxCursor) {
        maxCursor = cursor;
      }
    }
    return { nextSeq: Math.max(validCount, maxSeq) + 1, maxCursor };
  } catch {
    return { nextSeq: 1, maxCursor: 0 };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

function stringify(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
