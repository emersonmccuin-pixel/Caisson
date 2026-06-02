// Agent delivery — mailbox-only (slice 017 Phase C).
//
// Every agent → recipient envelope (terminal completed/failed, queued-started,
// asks-orchestrator/user, approval) is delivered as a durable mailbox message
// to the dispatcher's orchestrator session. The slice-007 mailbox worker drains
// it into exactly one runtime turn.
//
// The legacy Channel transport (per-CC bridge push via `enqueueAndPush` /
// `drainPendingForSession` / the `PC_DELIVERY_*` gate) was deleted in 017 Phase C
// once the mailbox was verified the sole delivery door. There is no fallback.

import { newId, type EnqueueMailboxMessageInput } from '@pc/db';
import type { AgentInboxEventKind, ULID } from '@pc/domain';
import type { MailboxMessageKind } from '@pc/contracts';

export interface EnqueueAndPushInput {
  projectId: ULID;
  pcSessionId: string;
  kind: AgentInboxEventKind;
  slug: string;
  source: string;
  body: string;
  sender?: string;
}

export interface EnqueueAndPushResult {
  /** Always null on the mailbox path — no agent_inbox row is written. Retained
   *  so existing callers (pause-resume's `eventInboxId`) compile unchanged. */
  inboxId: ULID | null;
  /** Always false on the mailbox path — there is no best-effort Channel push.
   *  Retained for the same reason (`eventDelivered` HTTP field). */
  channelDelivered: boolean;
}

// ──────────────────────── gated → mailbox-only agent delivery ────────────────

/** A narrow mailbox enqueue port (the slice-007 MailboxService.enqueue). Kept
 *  structural so this module imports no app-services value. */
export type MailboxEnqueuePort = (input: EnqueueMailboxMessageInput) => unknown;

/** A human subject for the mailbox card title, so the inbox shows e.g.
 *  "Agent researcher completed" instead of the raw `[pc:agent-event …]` body
 *  marker. `slug` is the agent name. */
function mailboxSubjectFor(kind: AgentInboxEventKind, slug: string): string | null {
  const agent = slug.trim() || 'agent';
  switch (kind) {
    case 'agent-completed':       return `Agent ${agent} completed`;
    case 'agent-failed':          return `Agent ${agent} failed`;
    case 'agent-queued-started':  return `Agent ${agent} started`;
    case 'agent-asks-orchestrator':
    case 'agent-asks-user':       return `Agent ${agent} is asking a question`;
    case 'agent-approval-request': return `Agent ${agent} needs approval`;
    default:                      return `Agent ${agent}`;
  }
}

function mailboxMessageKindFor(kind: AgentInboxEventKind): MailboxMessageKind {
  switch (kind) {
    case 'agent-asks-orchestrator':
    case 'agent-asks-user':
      return 'agent-question';
    case 'agent-approval-request':
      return 'agent-approval';
    default:
      return 'agent-terminal';
  }
}

export interface DeliverAgentEnvelopeInput extends EnqueueAndPushInput {
  /** Stable per-event idempotency key:
   *  `agent:${runId}:${eventKind}` for terminal/queued-started, or
   *  `agent-ask:${pendingAskId}` for asks. */
  idempotencyKey: string;
  /** Source ref for the mailbox message (runId or pendingAskId). */
  sourceId?: string | null;
}

export interface DeliverAgentEnvelopeDeps {
  mailboxEnqueue: MailboxEnqueuePort;
  now?: () => number;
}

/** Route ONE agent delivery envelope to the dispatcher's orchestrator session
 *  as a durable mailbox message. The slice-007 worker delivers exactly one
 *  runtime turn per event. */
export function deliverAgentEnvelope(
  input: DeliverAgentEnvelopeInput,
  deps: DeliverAgentEnvelopeDeps,
): EnqueueAndPushResult {
  deps.mailboxEnqueue({
    message: {
      id: newId(),
      projectId: input.projectId,
      kind: mailboxMessageKindFor(input.kind),
      subject: mailboxSubjectFor(input.kind, input.slug),
      body: input.body,
      sourceKind: 'agent',
      sourceId: input.sourceId ?? null,
      idempotencyKey: input.idempotencyKey,
    },
    recipients: [
      {
        id: newId(),
        addressKind: 'orchestrator-session',
        addressJson: {
          kind: 'orchestrator-session',
          projectId: input.projectId,
          sessionId: input.pcSessionId,
        },
        channel: 'orchestrator-turn',
        deliveryId: newId(),
      },
    ],
    now: (deps.now ?? Date.now)(),
  });
  return { inboxId: null, channelDelivered: false };
}
