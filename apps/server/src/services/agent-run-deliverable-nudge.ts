// P9/FD-17 — the deliverable-skip nudge (the "marco" class).
//
// Delivery is the SOLE done-signal (workflow-engine redesign): a worker that
// ends its turn without calling `pc_submit_deliverable` used to sit silent
// until the 5min idle-kill executed it. Now, the MOMENT the turn-end lands:
//
//   strike 1 → inject a marked reminder into the run (host `send`): submit the
//              deliverable or ask the orchestrator. Event-driven — the marco
//              case self-corrects in seconds, not minutes.
//   strike 2 → ONE durable `agent-stalled` mailbox to the active orchestrator
//              (reason: no deliverable twice). Still no kill — the orchestrator
//              decides (inspect / kill+re-dispatch / wait).
//
// Candidates: contract-first runs (contractId set) still `running` with no
// `deliveredAt`. Paused runs (a pending ask IS the legitimate way to stop
// without delivering) and the orchestrator chat (no agent_runs row at all)
// never reach here. Strike state is caller-owned (the reconciler's host-event
// subscription) and cleared on run-terminal.

import type { AgentRunRow, ULID } from '@pc/domain';
import { newId } from '@pc/db';

import type { MailboxEnqueuePort } from './agent-delivery.ts';

export const DELIVERABLE_NUDGE_TEXT =
  '[pc:system kind=deliverable-nudge] Your turn ended without a submitted ' +
  'deliverable. If the work is complete, call pc_submit_deliverable now — ' +
  'delivery is the ONLY done-signal; nothing else completes this task. If you ' +
  'are blocked or need direction, call pc_ask_orchestrator. Do not end ' +
  'another turn without one of those calls.';

export interface DeliverableNudgeDeps {
  /** Caller-owned strike counter per runId; cleared on run-terminal. */
  strikes: Map<string, number>;
  /** Inject text into the live run (host `send`). Fire-and-forget. */
  sendToRun: (runId: ULID, text: string) => void;
  /** Strike 2's door. Absent ⇒ nudge-only. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  now?: () => number;
}

export type DeliverableNudgeOutcome = 'skipped' | 'nudged' | 'notified' | 'exhausted';

/** Called on every live `jsonl-turn-end` for a worker run. */
export function onWorkerTurnEndWithoutDeliverable(
  row: AgentRunRow,
  deps: DeliverableNudgeDeps,
): DeliverableNudgeOutcome {
  // Only contract-first runs owe a deliverable; only a still-running run can
  // be nudged (paused = legitimately waiting on an ask; terminal = settled).
  if (row.status !== 'running') return 'skipped';
  if (row.contractId === null) return 'skipped';
  if (row.deliveredAt !== null) return 'skipped';

  const strikes = deps.strikes.get(row.id) ?? 0;

  if (strikes === 0) {
    deps.strikes.set(row.id, 1);
    deps.sendToRun(row.id as ULID, DELIVERABLE_NUDGE_TEXT);
    return 'nudged';
  }

  if (strikes === 1) {
    deps.strikes.set(row.id, 2);
    if (deps.mailboxEnqueue) {
      enqueueNoDeliverableNotify(deps.mailboxEnqueue, row, (deps.now ?? Date.now)());
      return 'notified';
    }
    return 'exhausted';
  }

  // Already notified — the orchestrator owns it now. No nudge spam.
  return 'exhausted';
}

/** Strike 2's envelope. Same `agent-stalled` kind as the silence ladder (one
 *  triage lane for the orchestrator); idempotency key is per-run — a run gets
 *  at most ONE no-deliverable escalation in its lifetime. */
function enqueueNoDeliverableNotify(
  mailboxEnqueue: MailboxEnqueuePort,
  row: AgentRunRow,
  now: number,
): void {
  const body =
    `Agent ${row.podName} (run ${row.id}) ended a turn without submitting a ` +
    `deliverable TWICE — a reminder was injected after the first time. It is ` +
    `still running and has NOT been killed. Likely causes: the brief is ` +
    `degenerate or unclear, or the agent believes it is already done. ` +
    `Decide: pc_inspect_agent_run for the transcript tail, pc_kill_agent_run ` +
    `+ re-dispatch with a clearer brief, or wait if it looks mid-correction.`;

  mailboxEnqueue({
    message: {
      id: newId(),
      projectId: row.projectId,
      kind: 'agent-stalled',
      subject: `Agent ${row.podName} stopped without delivering`,
      body,
      sourceKind: 'agent',
      sourceId: row.id,
      idempotencyKey: `agent-no-deliverable:${row.id}`,
    },
    recipients: [
      {
        id: newId(),
        addressKind: 'active-orchestrator',
        addressJson: { kind: 'active-orchestrator', projectId: row.projectId },
        channel: 'orchestrator-turn',
        deliveryId: newId(),
      },
    ],
    now,
  });
}
