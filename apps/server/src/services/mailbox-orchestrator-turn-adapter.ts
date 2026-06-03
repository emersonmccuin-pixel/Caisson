// Slice 007 — mailbox `orchestrator-turn` delivery adapter (server layer).
//
// Wraps the SYNC slice-006 ConversationSendService.enqueueRuntimeTurn facade
// (returns `{ row, created }`; signals failure only by throwing). It is NOT the
// foundation-spec §8 async RuntimeTurnDeliveryPort — the facade shape differs
// and is sufficient (accepted = a send-queue row exists). The mapping:
//
//   - a returned `row` (created OR replayed) -> `accepted`, target_ref
//     `{ kind:'send-queue', id: row.id }`
//   - a thrown enqueue error                 -> retryable failure
//
// A STABLE mailbox-derived clientMessageId (`mb:${deliveryId}`) makes a
// reclaimed/retried delivery idempotent by `(sessionId, clientMessageId)` — the
// same send-queue row comes back (`created:false`), so at most ONE runtime turn
// is ever queued per delivery. NEVER raw-sends; NEVER calls enqueueAndPush /
// postChannel. The facade signature is unchanged (stop-condition).

import type { ConversationSendService } from '@pc/app-services';
import type { ULID } from '@pc/domain';
import { ensureSystemTurnMarker } from '@pc/runtime/chat-policy';

export interface OrchestratorTurnDeliveryInput {
  projectId: ULID;
  sessionId: ULID;
  deliveryId: ULID;
  text: string;
  /** Mailbox message kind (agent-terminal, workflow-review, …). Used for the
   *  FD-3/FD-6 fallback `[pc:system kind=…]` header when the composed body
   *  doesn't already start with a `[pc:…]` marker. */
  kind?: string | null;
}

export type OrchestratorTurnDeliveryResult =
  | { ok: true; sendQueueId: string }
  | { ok: false; error: string; retryable: boolean };

/** Stable mailbox-derived clientMessageId so re-delivery yields one send row. */
export function mailboxClientMessageId(deliveryId: ULID): string {
  return `mb:${deliveryId}`;
}

export class MailboxOrchestratorTurnAdapter {
  constructor(private readonly sendService: ConversationSendService) {}

  deliver(input: OrchestratorTurnDeliveryInput): OrchestratorTurnDeliveryResult {
    try {
      const { row } = this.sendService.enqueueRuntimeTurn({
        projectId: input.projectId,
        sessionId: input.sessionId,
        clientMessageId: mailboxClientMessageId(input.deliveryId),
        // FD-3/FD-6 — the ONE injection door guarantees every injected turn
        // starts with a `[pc:…]` system marker. The marker survives into CC's
        // transcript, so the chat can render + filter these as system messages.
        text: ensureSystemTurnMarker(input.text, input.kind ?? 'notice'),
        source: 'mailbox',
        sourceRef: input.deliveryId,
      });
      return { ok: true, sendQueueId: row.id };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'enqueueRuntimeTurn threw',
        retryable: true,
      };
    }
  }
}
