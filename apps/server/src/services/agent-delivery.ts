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

import { getOrchestratorSession, newId, type EnqueueMailboxMessageInput } from '@pc/db';
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
    case 'agent-asks-orchestrator': return `Agent ${agent} is asking a question`;
    case 'agent-approval-request': return `Agent ${agent} needs approval`;
    default:                      return `Agent ${agent}`;
  }
}

function mailboxMessageKindFor(kind: AgentInboxEventKind): MailboxMessageKind {
  switch (kind) {
    case 'agent-asks-orchestrator':
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
  /** M4a — is `pcSessionId` a REAL orchestrator session (an
   *  orchestrator_sessions row)? Workflow-engine dispatches mint synthetic
   *  dispatcher ids; pre-M4a those envelopes burned five worker retries each
   *  and dead-lettered. Defaults to the db lookup; tests inject. */
  sessionExists?: (sessionId: string) => boolean;
}

/** Asks MUST reach a human-adjacent brain (FD-6/FD-8): when the dispatcher
 *  isn't a real orchestrator session (workflow worker), fall back to whichever
 *  orchestrator IS (or next becomes) active for the project. */
const ASK_KINDS: ReadonlySet<AgentInboxEventKind> = new Set([
  'agent-asks-orchestrator',
  'agent-approval-request',
]);

export interface DeliverAgentEnvelopeResult extends EnqueueAndPushResult {
  /** M4a — true when the envelope was deliberately NOT enqueued: a terminal/
   *  informational notice addressed to a synthetic dispatcher session. The
   *  engine consumes the outcome itself; the run diary + workflow-run-failed /
   *  review messages own the durable signal. (These never delivered in any
   *  era — pre-mailbox they queued for a session id no hook would ever match.) */
  skipped?: boolean;
}

/** Route ONE agent delivery envelope as a durable mailbox message. Real
 *  dispatcher session → that session. Synthetic dispatcher (workflow worker):
 *  asks fall back to the project's active orchestrator; informational
 *  terminal notices are skipped (see DeliverAgentEnvelopeResult.skipped). */
export function deliverAgentEnvelope(
  input: DeliverAgentEnvelopeInput,
  deps: DeliverAgentEnvelopeDeps,
): DeliverAgentEnvelopeResult {
  const sessionExists =
    deps.sessionExists ?? ((id: string) => getOrchestratorSession(id as ULID) !== null);
  const real = sessionExists(input.pcSessionId);

  if (!real && !ASK_KINDS.has(input.kind)) {
    return { inboxId: null, channelDelivered: false, skipped: true };
  }

  const recipient = real
    ? {
        id: newId(),
        addressKind: 'orchestrator-session' as const,
        addressJson: {
          kind: 'orchestrator-session' as const,
          projectId: input.projectId,
          sessionId: input.pcSessionId,
        },
        channel: 'orchestrator-turn' as const,
        deliveryId: newId(),
      }
    : {
        id: newId(),
        addressKind: 'active-orchestrator' as const,
        addressJson: {
          kind: 'active-orchestrator' as const,
          projectId: input.projectId,
        },
        channel: 'orchestrator-turn' as const,
        deliveryId: newId(),
      };

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
    recipients: [recipient],
    now: (deps.now ?? Date.now)(),
  });
  return { inboxId: null, channelDelivered: false };
}
