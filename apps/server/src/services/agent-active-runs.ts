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
  markPaused(askId: string): void;
  resumeWithAnswer(answer: string): Promise<ResumeWithAnswerResult>;
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

  markPaused(askId: string): void {
    this.snapshot = {
      ...this.snapshot,
      state: 'paused',
      updatedAt: this.now(),
    };
    this.issue({ type: 'mark-paused', runId: this.snapshot.runId, askId });
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
