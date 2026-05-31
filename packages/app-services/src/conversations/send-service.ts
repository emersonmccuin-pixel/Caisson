// ConversationSendService (slice 006).
//
// A thin command facade over the EXISTING durable send queue + delivery
// behaviors. It is NOT a new durable-write-door: the `orchestrator_send_queue`
// repo is already durable and FIFO-correlated; this facade only names the
// existing behaviors as commands so the WS/route call sites delegate instead of
// re-implementing the policy. Wire shapes (`send-ack`, `send-queue-snapshot`,
// status codes) stay in the route/WS adapter and are unchanged.
//
// The PTY is reached ONLY through an injected `RuntimeTurnPort` (getState /
// sendToPty) — the facade never imports a PTY class, the WS hub, Channel, or
// runtime process classes. `enqueueRuntimeTurn` is the mailbox-safe entry point:
// idempotent by `(sessionId, clientMessageId)`, returns the queue row, and NEVER
// raw-sends (the delivery loop drains it). Boundary purity: @pc/contracts +
// @pc/db + @pc/domain.

import {
  cancelQueuedOrchestratorSend,
  enqueueOrchestratorSend,
  getActiveOrchestratorSession,
  getOrchestratorSendByClientMessageId,
  getOrchestratorSendQueueRow,
  hasOpenOrchestratorSendsForSession,
  listQueuedOrchestratorSendsForSession,
  listVisibleOrchestratorSendsForSession,
  markNextDeliveredOrchestratorSendObservedInJsonl,
  markOrchestratorSendDelivered,
  markOrchestratorSendDelivering,
  markOrchestratorSendFailed,
  newId,
  recordDeliveredOrchestratorSend,
  retryFailedOrchestratorSend,
  type OrchestratorSendQueueRow,
  type OrchestratorSendQueueStatus,
} from '@pc/db';
import type { OrchestratorSession, ULID } from '@pc/domain';
import type { RuntimeTurnSource } from '@pc/contracts';

type SendResult = string | void;

/** Read-only PTY seam: state + send. No raw write surface is exposed to the
 *  facade (mailbox/system turns go through the queue, never a raw send). */
export interface RuntimeTurnPort {
  getState(): string;
  send(text: string): Promise<SendResult> | SendResult;
}

export interface ConversationSendDeps {
  /** Resolve the live PTY for a project, or null if none is attached. */
  getPort(projectId: ULID): RuntimeTurnPort | null;
  /** Mint/attach the active session when a user turn arrives with none. */
  ensureActiveSession(projectId: ULID): OrchestratorSession;
  /** Lazily start/attach the PTY (mirrors `ensureOrchestratorPty`). May throw. */
  ensurePort(projectId: ULID): RuntimeTurnPort;
  /** Push the current send-queue snapshot (the existing legacy projection). */
  broadcastSendQueueSnapshot(projectId: ULID, sessionId: ULID): void;
  /** Emit the `session-changed` + `session-replay` envelopes when a user turn
   *  first mints the active session (mirrors the existing handlePromptSend). */
  onSessionEnsured?(projectId: ULID, session: OrchestratorSession): void;
}

export type SendUserTurnResult =
  | { ok: true; status: 'received' | 'queued'; row: OrchestratorSendQueueRow }
  | { ok: false; status: 'no-session' | 'error'; error: string };

function queuedStatusForState(
  state: string,
  hasBacklog: boolean,
): Extract<OrchestratorSendQueueStatus, 'queued_busy' | 'queued_spawning' | 'queued_backlog'> {
  if (hasBacklog) return 'queued_backlog';
  if (state === 'spawning') return 'queued_spawning';
  return 'queued_busy';
}

export class ConversationSendService {
  private readonly deps: ConversationSendDeps;
  private readonly deliveryInFlight = new Set<ULID>();

  constructor(deps: ConversationSendDeps) {
    this.deps = deps;
  }

  /** The `handlePromptSend` policy: ensure an active session, then direct-send
   *  when ready+no-backlog else enqueue (with the correct queued_* status) and
   *  drain. Returns a structured result the WS adapter maps to `send-ack`. */
  async sendUserTurn(input: {
    projectId: ULID;
    clientMessageId?: string;
    text: string;
  }): Promise<SendUserTurnResult> {
    const { projectId } = input;
    const clientMessageId =
      typeof input.clientMessageId === 'string' && input.clientMessageId
        ? input.clientMessageId
        : newId();

    let active = getActiveOrchestratorSession(projectId);
    if (!active) {
      active = this.deps.ensureActiveSession(projectId);
      this.deps.onSessionEnsured?.(projectId, active);
      this.deps.broadcastSendQueueSnapshot(projectId, active.id);
    }

    let port = this.deps.getPort(projectId);
    if (!port) {
      try {
        port = this.deps.ensurePort(projectId);
      } catch (err) {
        return {
          ok: false,
          status: 'no-session',
          error:
            err instanceof Error
              ? err.message
              : 'No live orchestrator session is attached',
        };
      }
    }

    const state = port.getState();
    const hasBacklog = hasOpenOrchestratorSendsForSession(active.id);
    if (state !== 'ready' || hasBacklog) {
      try {
        const row = enqueueOrchestratorSend({
          projectId,
          sessionId: active.id,
          clientMessageId,
          text: input.text,
          status: queuedStatusForState(state, hasBacklog),
        });
        this.deps.broadcastSendQueueSnapshot(projectId, active.id);
        if (state === 'ready') this.deliverNextQueuedTurn(projectId);
        return { ok: true, status: 'queued', row };
      } catch (err) {
        return {
          ok: false,
          status: 'error',
          error: err instanceof Error ? err.message : 'Failed to queue prompt',
        };
      }
    }

    try {
      const result = await port.send(input.text);
      if (result !== 'ok') {
        return { ok: false, status: 'error', error: `send returned ${result}` };
      }
      const row = recordDeliveredOrchestratorSend({
        projectId,
        sessionId: active.id,
        clientMessageId,
        text: input.text,
      });
      this.deps.broadcastSendQueueSnapshot(projectId, active.id);
      return { ok: true, status: 'received', row };
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to send prompt',
      };
    }
  }

  /** Mailbox/system entry point. Idempotent by `(sessionId, clientMessageId)`:
   *  a replay returns the existing row. NEVER raw-sends — the row is queued and
   *  the delivery loop drains it. `source`/`sourceRef` are accepted for the
   *  mailbox target ref but the persisted queue row is unchanged this slice. */
  enqueueRuntimeTurn(input: {
    projectId: ULID;
    sessionId: ULID;
    clientMessageId: string;
    text: string;
    source?: RuntimeTurnSource;
    sourceRef?: string;
  }): { row: OrchestratorSendQueueRow; created: boolean } {
    const existing = getOrchestratorSendByClientMessageId(
      input.sessionId,
      input.clientMessageId,
    );
    if (existing) return { row: existing, created: false };

    const port = this.deps.getPort(input.projectId);
    const state = port?.getState() ?? 'spawning';
    const hasBacklog = hasOpenOrchestratorSendsForSession(input.sessionId);
    const row = enqueueOrchestratorSend({
      projectId: input.projectId,
      sessionId: input.sessionId,
      clientMessageId: input.clientMessageId,
      text: input.text,
      status: queuedStatusForState(state, hasBacklog),
    });
    this.deps.broadcastSendQueueSnapshot(input.projectId, input.sessionId);
    return { row, created: true };
  }

  /** Drain the next queued turn for the project's active session (single-flight
   *  per session). Mirrors `deliverNextQueuedPrompt`. */
  deliverNextQueuedTurn(projectId: ULID): void {
    const active = getActiveOrchestratorSession(projectId);
    if (!active) return;
    if (this.deliveryInFlight.has(active.id)) return;
    this.deliveryInFlight.add(active.id);
    void this.deliverNextQueuedTurnOnce(projectId, active.id).finally(() => {
      this.deliveryInFlight.delete(active.id);
    });
  }

  async deliverNextQueuedTurnOnce(projectId: ULID, sessionId: ULID): Promise<void> {
    const active = getActiveOrchestratorSession(projectId);
    if (!active || active.id !== sessionId) return;
    const port = this.deps.getPort(projectId);
    if (!port || port.getState() !== 'ready') {
      this.deps.broadcastSendQueueSnapshot(projectId, active.id);
      return;
    }
    const [next] = listQueuedOrchestratorSendsForSession(active.id);
    if (!next) {
      this.deps.broadcastSendQueueSnapshot(projectId, active.id);
      return;
    }
    markOrchestratorSendDelivering(next.id);
    this.deps.broadcastSendQueueSnapshot(projectId, active.id);
    try {
      const result = await port.send(next.text);
      if (result === 'ok') markOrchestratorSendDelivered(next.id);
      else markOrchestratorSendFailed(next.id, `send returned ${result}`);
    } catch (err) {
      markOrchestratorSendFailed(
        next.id,
        err instanceof Error ? err.message : 'Failed to deliver queued prompt',
      );
    }
    this.deps.broadcastSendQueueSnapshot(projectId, active.id);
  }

  /** Correlate a parsed `jsonl-user` event to its originating queued send (the
   *  one-time text+FIFO match), advance it to `observed_in_jsonl`, and drain the
   *  next prompt. Returns the matched row so the caller can stamp its
   *  `clientMessageId` onto the canonical envelope. Mirrors
   *  `maybeAdvanceSendQueueConfirmation`. */
  observeUserJsonl(input: {
    projectId: ULID;
    sessionId: ULID | null;
    event: unknown;
  }): OrchestratorSendQueueRow | undefined {
    const { event, projectId, sessionId } = input;
    if (!sessionId || !event || typeof event !== 'object') return undefined;
    const ev = event as { kind?: string; text?: unknown };
    if (ev.kind !== 'jsonl-user' || typeof ev.text !== 'string') return undefined;
    const observed = markNextDeliveredOrchestratorSendObservedInJsonl(sessionId, ev.text);
    if (!observed) return undefined;
    this.deps.broadcastSendQueueSnapshot(projectId, sessionId);
    if (this.deps.getPort(projectId)?.getState() === 'ready') {
      this.deliverNextQueuedTurn(projectId);
    }
    return observed;
  }

  /** Cancel a queued turn (only queued statuses). Returns the cancelled row or
   *  undefined when it was not cancellable. */
  cancelQueuedTurn(input: {
    sendId: ULID;
    sessionId: ULID;
    reason: string;
  }): OrchestratorSendQueueRow | undefined {
    return cancelQueuedOrchestratorSend(input.sendId, input.sessionId, input.reason);
  }

  /** Retry a failed turn (only failed status), re-queued at the correct
   *  queued_* status for the current PTY state + backlog. */
  retryFailedTurn(input: {
    sendId: ULID;
    sessionId: ULID;
    state: string;
    hasBacklog: boolean;
  }): OrchestratorSendQueueRow | undefined {
    return retryFailedOrchestratorSend(
      input.sendId,
      input.sessionId,
      queuedStatusForState(input.state, input.hasBacklog),
    );
  }

  /** The visible send-queue for the session (drives `send-queue-snapshot`). */
  listVisibleTurns(sessionId: ULID): OrchestratorSendQueueRow[] {
    return listVisibleOrchestratorSendsForSession(sessionId);
  }

  getQueueRow(sendId: ULID): OrchestratorSendQueueRow | undefined {
    return getOrchestratorSendQueueRow(sendId);
  }
}
