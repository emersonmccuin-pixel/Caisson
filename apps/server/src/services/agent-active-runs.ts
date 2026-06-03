// Section 25 — in-memory registry of active AgentRuns.
//
// Pause / resume / continuation primitives look up live AgentRuns by various
// identifiers — agent_run_id (the primary key), pending_ask_id of an
// outstanding pause, or the CC provider session-id when the JSONL
// pause-detector fires.
//
// The registry is a thin process-wide Map. It does NOT own the run lifecycle.
// Callers register an ActiveRunHandle after the run starts; the handle's
// terminal callback auto-unregisters when the run completes.
//
// Each entry carries dispatcher metadata so the pause/resume layer can
// build the channel-event body (which references projectId / dispatcher
// session / parent work item) without re-querying the DB.

import type { ULID } from '@pc/domain';
import type {
  AgentHostCommand,
  AgentHostCommandResponse,
  AgentHostRunSnapshot,
  AgentRun,
  AgentRunRecord,
  AgentRunState,
} from '@pc/runtime';

// Type-only (no runtime cycle): the terminal authority lives in
// agent-run-terminal-effects.ts, which type-imports ActiveRunRegistry from here.
import type { TerminalSettlement } from './agent-run-terminal-effects.ts';

/** Slice 009 OBJ-2 — the outcome of threading an answer into a paused run.
 *  In-process resume is synchronous and (post pre-validation) always `ok`. The
 *  host path awaits the host command response and maps a `not-resumable` /
 *  failed reply so the server can finalize via `resume-failed` instead of
 *  stranding the run `running`. */
export type ResumeWithAnswerResult =
  | { ok: true }
  | { ok: false; cause: 'not-resumable' | 'host-error'; error: string };

export interface ActiveRunHandle {
  getRecord(): Pick<AgentRunRecord, 'agentRunId'>;
  getState(): AgentRunState;
  cancel(): void;
  notifyMcpHandshake(): void;
  /** Flip the run to paused. Host-backed runs AWAIT the host ack (slice 009
   *  OBJ-2): the explicit-pause caller must not let the agent's `pc_ask_*` tool
   *  return — and the agent end its turn — until the HOST run is actually
   *  paused, else the host tails the turn-end and completes the run before the
   *  fire-and-forget mark-paused lands, dropping the eventual answer. */
  markPaused(askId: string): void | Promise<void>;
  resumeWithAnswer(answer: string): Promise<ResumeWithAnswerResult>;
  /** Workflow-engine redesign — drive running→completed from the deliverable
   *  receipt (`pc_submit_deliverable`), the sole done-signal. In-process this
   *  calls AgentRun.complete(); host-backed runs complete via their own
   *  turn-end + the server completion gate, so this is a no-op there. */
  complete(result?: string): void;
  onTerminal(listener: () => void): void;
}

export function activeRunHandleForAgentRun(run: AgentRun): ActiveRunHandle {
  return {
    getRecord: () => run.getRecord(),
    getState: () => run.getState(),
    cancel: () => run.cancel(),
    notifyMcpHandshake: () => run.notifyMcpHandshake(),
    markPaused: (askId) => run._markPaused(askId),
    // In-process: `answerPendingAsk` pre-validates `state==='paused'`, so this
    // drives the resume synchronously; a spawn failure surfaces async through
    // the run's own terminal path. Always reports `ok` here.
    resumeWithAnswer: async (answer) => {
      run._resumeWithAnswer(answer);
      return { ok: true };
    },
    complete: (result) => run.complete(result),
    onTerminal: (listener) => {
      run.once('terminal', listener);
    },
  };
}

export interface AgentHostCommandSender {
  sendCommand(
    command: AgentHostCommand,
  ): AgentHostCommandResponse | Promise<AgentHostCommandResponse> | void;
}

export interface HostBackedActiveRunHandleOptions {
  onCommandError?: (error: Error, command: AgentHostCommand) => void;
  now?: () => number;
}

export class HostBackedActiveRunHandle implements ActiveRunHandle {
  private snapshot: AgentHostRunSnapshot;
  private readonly terminalListeners: Array<() => void> = [];
  private terminalFired = false;
  private readonly now: () => number;

  constructor(
    snapshot: AgentHostRunSnapshot,
    private readonly host: AgentHostCommandSender,
    private readonly options: HostBackedActiveRunHandleOptions = {},
  ) {
    this.snapshot = snapshot;
    this.now = options.now ?? Date.now;
    this.maybeFireTerminal();
  }

  getRecord(): Pick<AgentRunRecord, 'agentRunId'> {
    return { agentRunId: this.snapshot.runId };
  }

  getState(): AgentRunState {
    return this.snapshot.state;
  }

  cancel(): void {
    this.issue({ type: 'cancel', runId: this.snapshot.runId });
  }

  notifyMcpHandshake(): void {
    this.issue({
      type: 'notify-mcp-handshake',
      ccSessionId: this.snapshot.ccSessionId,
    });
  }

  async markPaused(askId: string): Promise<void> {
    // Optimistic local snapshot so a non-awaiting getState() reads paused.
    this.snapshot = {
      ...this.snapshot,
      state: 'paused',
      updatedAt: this.now(),
    };
    // Slice 009 OBJ-2 — AWAIT the host ack (was fire-and-forget). The caller
    // (recordExplicitPause) blocks the agent's pc_ask_* tool response on this,
    // so the host run is genuinely `paused` before the agent ends its turn.
    // Otherwise the host tails the turn-end and toTerminal('completed')s the run
    // while mark-paused is still in flight, and the answer later no-ops.
    const command: AgentHostCommand = {
      type: 'mark-paused',
      runId: this.snapshot.runId,
      askId,
    };
    try {
      const response = await Promise.resolve(this.host.sendCommand(command));
      if (response && response.ok) this.applyCommandResponse(response);
    } catch (err) {
      this.reportCommandError(err, command);
    }
  }

  async resumeWithAnswer(answer: string): Promise<ResumeWithAnswerResult> {
    // Slice 009 OBJ-2 — AWAIT the host command (not fire-and-forget) so the
    // server can observe a `not-resumable` reply and finalize the run instead of
    // stranding it `running`. Still applies the returned snapshot on success.
    const command: AgentHostCommand = {
      type: 'answer-pending',
      runId: this.snapshot.runId,
      text: answer,
    };
    try {
      const response = await Promise.resolve(this.host.sendCommand(command));
      if (!response) return { ok: true };
      if (response.ok) {
        this.applyCommandResponse(response);
        return { ok: true };
      }
      return {
        ok: false,
        cause: response.code === 'not-resumable' ? 'not-resumable' : 'host-error',
        error: response.error,
      };
    } catch (err) {
      this.reportCommandError(err, command);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, cause: 'host-error', error: message };
    }
  }

  /** Host-backed runs complete via their own turn-end → run-terminal snapshot,
   *  which routes through the server completion gate (delivered-or-fail). The
   *  in-process active-completion shortcut doesn't apply, so this is a no-op.
   *  (Production has no out-of-process host today.) */
  complete(_result?: string): void {
    /* no-op — see doc comment */
  }

  onTerminal(listener: () => void): void {
    if (this.terminalFired) {
      listener();
      return;
    }
    this.terminalListeners.push(listener);
  }

  applySnapshot(snapshot: AgentHostRunSnapshot): void {
    if (snapshot.runId !== this.snapshot.runId) return;
    this.snapshot = snapshot;
    this.maybeFireTerminal();
  }

  private issue(command: AgentHostCommand): void {
    try {
      const response = this.host.sendCommand(command);
      if (!response || typeof (response as Promise<AgentHostCommandResponse>).then !== 'function') {
        this.applyCommandResponse(response as AgentHostCommandResponse | void);
        return;
      }
      void (response as Promise<AgentHostCommandResponse>)
        .then((res) => this.applyCommandResponse(res))
        .catch((err) => this.reportCommandError(err, command));
    } catch (err) {
      this.reportCommandError(err, command);
    }
  }

  private applyCommandResponse(response: AgentHostCommandResponse | void): void {
    if (!response || !response.ok || !('run' in response)) return;
    this.applySnapshot(response.run);
  }

  private reportCommandError(error: unknown, command: AgentHostCommand): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.options.onCommandError?.(err, command);
  }

  private maybeFireTerminal(): void {
    if (!isTerminalState(this.snapshot.state) || this.terminalFired) return;
    this.terminalFired = true;
    const listeners = this.terminalListeners.splice(0);
    for (const listener of listeners) listener();
  }
}

export interface ActiveRunEntry {
  run: ActiveRunHandle;
  projectId: ULID;
  dispatcherSessionId: string;
  ccSessionId: string;
  podName: string;
  parentWorkItemId: ULID | null;
  /** Pod row's `updated_at` (or revision string) captured at dispatch time.
   *  Drives §6.4 drift detection on resume. NULL when the materialiser
   *  didn't supply one. */
  podRevisionAtDispatch: string | null;
  registeredAt: number;
}

export interface RegisterActiveRunInput {
  run: ActiveRunHandle;
  projectId: ULID;
  dispatcherSessionId: string;
  ccSessionId: string;
  podName: string;
  parentWorkItemId?: ULID | null;
  podRevisionAtDispatch?: string | null;
  now?: number;
}

export class ActiveRunRegistry {
  private byRunId = new Map<string, ActiveRunEntry>();
  private byCcSession = new Map<string, ActiveRunEntry>();
  /** One terminal authority, one wake-up. A dispatch registers a settlement
   *  waiter keyed by run id BEFORE the run starts; the terminal authority
   *  (`applyAgentRunTerminalEffects`) fires it by run id whenever the run
   *  reaches terminal — regardless of WHICH host-event listener / reconcile
   *  sweep processed the terminal first. This is what makes the workflow `done`
   *  promise immune to the old double-subscribe race. Fires at most once. */
  private settlementWaiters = new Map<string, (settlement: TerminalSettlement) => void>();

  register(input: RegisterActiveRunInput): ActiveRunEntry {
    const entry: ActiveRunEntry = {
      run: input.run,
      projectId: input.projectId,
      dispatcherSessionId: input.dispatcherSessionId,
      ccSessionId: input.ccSessionId,
      podName: input.podName,
      parentWorkItemId: input.parentWorkItemId ?? null,
      podRevisionAtDispatch: input.podRevisionAtDispatch ?? null,
      registeredAt: input.now ?? Date.now(),
    };
    const runId = entry.run.getRecord().agentRunId;
    this.byRunId.set(runId, entry);
    this.byCcSession.set(entry.ccSessionId, entry);

    // Auto-cleanup on terminal. The terminal event fires exactly once per
    // run lifetime; subsequent listeners are no-ops because the run won't
    // emit further.
    entry.run.onTerminal(() => this.unregister(runId));
    return entry;
  }

  unregister(agentRunId: string): void {
    const entry = this.byRunId.get(agentRunId);
    if (!entry) return;
    this.byRunId.delete(agentRunId);
    if (this.byCcSession.get(entry.ccSessionId) === entry) {
      this.byCcSession.delete(entry.ccSessionId);
    }
  }

  /** Register a one-shot settlement waiter for a run. Called by a dispatch
   *  before `start()` so the terminal — applied by whichever listener wins —
   *  resolves the dispatch's `done` promise by run id. Overwrites any prior
   *  waiter for the same id (last dispatch wins; ids are unique in practice). */
  onSettled(runId: string, listener: (settlement: TerminalSettlement) => void): void {
    this.settlementWaiters.set(runId, listener);
  }

  /** Fire + remove the settlement waiter for a run. Idempotent: a re-entrant
   *  terminal (race / reconcile re-derive) finds no waiter and no-ops, so the
   *  waiter fires EXACTLY once. */
  settle(runId: string, settlement: TerminalSettlement): void {
    const waiter = this.settlementWaiters.get(runId);
    if (!waiter) return;
    this.settlementWaiters.delete(runId);
    waiter(settlement);
  }

  /** Drop a settlement waiter without firing it — for a dispatch whose start
   *  failed before the run could ever reach terminal (so `done` is discarded
   *  and the waiter would otherwise leak). */
  cancelSettlement(runId: string): void {
    this.settlementWaiters.delete(runId);
  }

  get(agentRunId: string): ActiveRunEntry | null {
    return this.byRunId.get(agentRunId) ?? null;
  }

  getByCcSession(ccSessionId: string): ActiveRunEntry | null {
    return this.byCcSession.get(ccSessionId) ?? null;
  }

  list(): ActiveRunEntry[] {
    return Array.from(this.byRunId.values());
  }

  /** Test-only utility — drop every entry without invoking listeners. */
  clear(): void {
    this.byRunId.clear();
    this.byCcSession.clear();
    this.settlementWaiters.clear();
  }
}

let singleton: ActiveRunRegistry | null = null;

export function getActiveRunRegistry(): ActiveRunRegistry {
  if (!singleton) singleton = new ActiveRunRegistry();
  return singleton;
}

/** Test-only override. Pass `null` to revert to a fresh singleton on the
 *  next `getActiveRunRegistry()` call. */
export function setActiveRunRegistryForTest(reg: ActiveRunRegistry | null): void {
  singleton = reg;
}

function isTerminalState(state: AgentRunState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}
