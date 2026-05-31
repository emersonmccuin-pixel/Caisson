import type { ULID } from '@pc/domain';
import {
  getActiveOrchestratorSession,
  listVisibleOrchestratorSendsForSession,
  listQueuedOrchestratorSendsForSession,
  markNextDeliveredOrchestratorSendObservedInJsonl,
  markOrchestratorSendDelivered,
  markOrchestratorSendDelivering,
  markOrchestratorSendFailed,
  type OrchestratorSendQueueRow,
} from '@pc/db';

type SendResult = string | void;

export interface OrchestratorSendSession {
  getState(): string;
  send(text: string): Promise<SendResult> | SendResult;
}

export interface OrchestratorSendRuntime {
  ptySession(): OrchestratorSendSession | null;
}

export type BroadcastSendQueueSnapshot = (projectId: ULID, sessionId: ULID) => void;

export interface PublicSendQueueItem {
  id: ULID;
  clientMessageId: string;
  text: string;
  status: OrchestratorSendQueueRow['status'];
  createdAt: number;
  updatedAt: number;
  deliveryAttempts: number;
  failureReason: string | null;
}

export function publicSendQueueItem(row: OrchestratorSendQueueRow): PublicSendQueueItem {
  return {
    id: row.id,
    clientMessageId: row.clientMessageId,
    text: row.text,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deliveryAttempts: row.deliveryAttempts,
    failureReason: row.failureReason,
  };
}

export function sendQueueSnapshotPayload(sessionId: ULID): {
  type: 'send-queue-snapshot';
  sessionId: ULID;
  items: PublicSendQueueItem[];
} {
  return {
    type: 'send-queue-snapshot',
    sessionId,
    items: listVisibleOrchestratorSendsForSession(sessionId).map(publicSendQueueItem),
  };
}

export function queuedStatusForState(
  state: string,
  hasBacklog: boolean,
): 'queued_busy' | 'queued_spawning' | 'queued_backlog' {
  if (hasBacklog) return 'queued_backlog';
  if (state === 'spawning') return 'queued_spawning';
  return 'queued_busy';
}

const sendQueueDeliveryInFlight = new Set<ULID>();

export function deliverNextQueuedPrompt(
  projectId: ULID,
  runtime: OrchestratorSendRuntime,
  broadcastSendQueueSnapshot: BroadcastSendQueueSnapshot,
): void {
  const active = getActiveOrchestratorSession(projectId);
  if (!active) return;
  if (sendQueueDeliveryInFlight.has(active.id)) return;
  sendQueueDeliveryInFlight.add(active.id);
  void deliverNextQueuedPromptOnce(
    projectId,
    runtime,
    active.id,
    broadcastSendQueueSnapshot,
  ).finally(() => {
    sendQueueDeliveryInFlight.delete(active.id);
  });
}

export async function deliverNextQueuedPromptOnce(
  projectId: ULID,
  runtime: OrchestratorSendRuntime,
  sessionId: ULID,
  broadcastSendQueueSnapshot: BroadcastSendQueueSnapshot,
): Promise<void> {
  // Drain loop. A SUCCESSFUL delivery returns immediately: the queue then
  // advances one-at-a-time as each `jsonl-user` echo correlates the delivered
  // row (FIFO, via maybeAdvanceSendQueueConfirmation), so we never fire two
  // bodies into the composer before the first is observed. A FAILED delivery
  // (e.g. echo-timeout) produces NO jsonl-user event to re-trigger the drain,
  // so without recovery the remaining queued prompts wedge forever. We instead
  // mark the head failed and CONTINUE to the next queued row, so one bad turn
  // can't strand the rest of the queue.
  for (;;) {
    const active = getActiveOrchestratorSession(projectId);
    if (!active || active.id !== sessionId) return;
    const live = runtime.ptySession();
    if (!live || live.getState() !== 'ready') {
      broadcastSendQueueSnapshot(projectId, active.id);
      return;
    }
    const [next] = listQueuedOrchestratorSendsForSession(active.id);
    if (!next) {
      broadcastSendQueueSnapshot(projectId, active.id);
      return;
    }
    markOrchestratorSendDelivering(next.id);
    broadcastSendQueueSnapshot(projectId, active.id);
    let delivered = false;
    try {
      const result = await live.send(next.text);
      if (result === 'ok') {
        markOrchestratorSendDelivered(next.id);
        delivered = true;
      } else {
        markOrchestratorSendFailed(next.id, `send returned ${result}`);
      }
    } catch (err) {
      markOrchestratorSendFailed(
        next.id,
        err instanceof Error ? err.message : 'Failed to deliver queued prompt',
      );
    }
    broadcastSendQueueSnapshot(projectId, active.id);
    // Success: stop and wait for the jsonl-user correlation to drain the next.
    // Failure: keep draining so the queue recovers instead of wedging.
    if (delivered) return;
  }
}

/** Correlate a parsed `jsonl-user` event to its originating queued send (the
 *  single one-time text+FIFO match), advancing it to `observed_in_jsonl` and
 *  draining the next prompt. Returns the matched row so callers can stamp its
 *  `clientMessageId` onto the canonical envelope (id-keyed placeholder reconcile,
 *  docs/chat-canonical-source-redesign.md Stage 1); `undefined` when no match. */
export function maybeAdvanceSendQueueConfirmation(
  projectId: ULID,
  sessionId: ULID | null,
  event: unknown,
  runtime: OrchestratorSendRuntime,
  broadcastSendQueueSnapshot: BroadcastSendQueueSnapshot,
): OrchestratorSendQueueRow | undefined {
  if (!sessionId || !event || typeof event !== 'object') return undefined;
  const ev = event as { kind?: string; text?: unknown };
  if (ev.kind !== 'jsonl-user' || typeof ev.text !== 'string') return undefined;
  const observed = markNextDeliveredOrchestratorSendObservedInJsonl(sessionId, ev.text);
  if (!observed) return undefined;
  broadcastSendQueueSnapshot(projectId, sessionId);
  if (runtime.ptySession()?.getState() === 'ready') {
    deliverNextQueuedPrompt(projectId, runtime, broadcastSendQueueSnapshot);
  }
  return observed;
}
