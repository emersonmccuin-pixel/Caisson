// M4b (FD-8) — the stale-ask watchdog: "expecting a response that never came."
//
// An agent's pc_ask_* question pauses the run and delivers to the project
// orchestrator. If nobody answers — orchestrator busy, confused, or simply
// absent (the delivery defers silently on a 60s cadence) — the run waits
// FOREVER with no escalation; the only surface was the project Activity
// Panel's passive list. FD-17's stall ladder deliberately excludes paused
// runs (a pause is intentional silence), so this is the missing complement:
//
//   open pending_ask older than the threshold → ONE `agent-ask-escalated`
//   message addressed to the project orchestrator (active-orchestrator), so
//   the orchestrator relays it in chat — NOT a UI inbox card (doctrine: agents
//   never reach the human directly; pc-pty-chat-317). The idempotency key
//   `ask-stale:<askId>` ensures it is minted once per ask, ever.
//   answer/cancel ride the EXISTING pending-ask doors. A decision through ANY
//   door clears the card: the doors resolve-by-source on ('agent', askId), the
//   same source the orchestrator ask envelope uses.
//
// The card is minted once per ask, ever — the idempotent enqueue makes every
// later pass a no-op, and the persistent actionable badge carries the nag.

import { getAgentRunRow, listOpenPendingAsksOlderThan, newId } from '@pc/db';
import type { PendingAskRow } from '@pc/domain';

import type { MailboxEnqueuePort } from './agent-delivery.ts';

/** 30 minutes — an orchestrator answer normally lands in seconds-to-minutes; the
 *  window gives it real headroom before bothering the human (user decision
 *  2026-06-05, after a 15m threshold escalated an ask the orchestrator answered
 *  at ~17m). The human card is a failsafe, not the primary path: agents ask the
 *  orchestrator, and only an unanswered-past-this-window ask escalates. */
export const STALE_ASK_THRESHOLD_MS = 30 * 60_000;
/** Sweep cadence (matches the mailbox defer recheck). */
export const STALE_ASK_SWEEP_MS = 60_000;

export interface PendingAskWatchdogDeps {
  mailboxEnqueue: MailboxEnqueuePort;
  /** Test seam — defaults to the all-projects repo query. */
  listStaleOpenAsks?: (cutoff: number) => PendingAskRow[];
  /** Agent name for the card subject. Defaults to the run row's podName. */
  getPodName?: (agentRunId: PendingAskRow['agentRunId']) => string | null;
  thresholdMs?: number;
  now?: () => number;
}

/** Run one sweep. Returns how many asks were escalated THIS pass (idempotent
 *  replays of already-carded asks don't count — the enqueue dedupes, we just
 *  don't know it here; the count is enqueue calls, which is fine for logs). */
export function sweepStalePendingAsks(deps: PendingAskWatchdogDeps): number {
  const now = (deps.now ?? Date.now)();
  const thresholdMs = deps.thresholdMs ?? STALE_ASK_THRESHOLD_MS;
  const list = deps.listStaleOpenAsks ?? listOpenPendingAsksOlderThan;
  const podName =
    deps.getPodName ?? ((runId) => getAgentRunRow(runId)?.podName ?? null);

  let escalated = 0;
  for (const ask of list(now - thresholdMs)) {
    const agent = podName(ask.agentRunId) ?? 'agent';
    const waitedMin = Math.max(1, Math.round((now - ask.createdAt) / 60_000));
    deps.mailboxEnqueue({
      message: {
        id: newId(),
        projectId: ask.projectId,
        kind: 'agent-ask-escalated',
        subject: `Agent ${agent} has been waiting ${waitedMin}m on ${
          ask.kind === 'approval' ? 'an approval' : 'a question'
        }`,
        body: ask.promptBody,
        payload: {
          pendingAskId: ask.id,
          agentRunId: ask.agentRunId,
          projectId: ask.projectId,
          askKind: ask.kind,
          promptBody: ask.promptBody,
          context: ask.context,
          options: ask.options,
          askedAt: ask.createdAt,
          podName: agent,
        },
        sourceKind: 'agent',
        sourceId: ask.id,
        idempotencyKey: `ask-stale:${ask.id}`,
      },
      recipients: [
        {
          id: newId(),
          addressKind: 'active-orchestrator',
          addressJson: { kind: 'active-orchestrator', projectId: ask.projectId },
          channel: 'orchestrator-turn',
          deliveryId: newId(),
        },
      ],
      now,
    });
    escalated += 1;
  }
  return escalated;
}
