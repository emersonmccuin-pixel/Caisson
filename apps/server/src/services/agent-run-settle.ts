// Workflow-engine first-principles redesign — the terminal "completion gate".
//
// Delivery is the SOLE agent done-signal. A dispatched worker is "done" only
// when it submits a deliverable (pc_submit_deliverable); reaching a terminal as
// `completed` with nothing delivered is the bug the redesign kills — it becomes
// a typed `no-deliverable` FAILURE with a reason, never a "completed-but-empty".
//
// This gate is the single chokepoint every terminal path funnels its proposed
// status through (in-process terminal-effects + the host-snapshot path), so the
// invariant holds no matter which path detected the process stopping.
//
// Scope: only CONTRACT-FIRST runs are gated. A run with no contract (legacy /
// non-contract dispatch) has nothing to deliver against and is exempt — it keeps
// the prior behaviour. The deliverable lives on the contract (ContractService),
// with `agent_runs.delivered_at` as a cheap positive receipt.

import type { AgentRunFailureCause, AgentRunRow, ULID } from '@pc/domain';
import { ContractService } from '@pc/app-services';

export const NO_DELIVERABLE_REASON =
  'the worker reached a terminal without submitting a deliverable (pc_submit_deliverable)';

export interface ProposedTerminal {
  status: 'completed' | 'failed' | 'cancelled';
  failureCause: AgentRunFailureCause | null;
  failureReason: string | null;
}

export interface GatedTerminal extends ProposedTerminal {
  /** True when a proposed `completed` was downgraded to a no-deliverable fail. */
  downgraded: boolean;
}

export interface CompletionGateDeps {
  contractService?: ContractService;
  /** Test seam — override the deliverable-presence probe (skips the DB read). */
  contractHasDeliverable?: (contractId: ULID) => boolean;
}

/** Apply the completion gate. Returns the EFFECTIVE terminal: an ungated pass-
 *  through unless a contract-first run proposed `completed` with no delivered
 *  output, which is rewritten to `failed / no-deliverable`. */
export function gateTerminalForDeliverable(
  proposed: ProposedTerminal,
  row: Pick<AgentRunRow, 'contractId' | 'deliveredAt'>,
  deps: CompletionGateDeps = {},
): GatedTerminal {
  if (proposed.status !== 'completed') return { ...proposed, downgraded: false };

  const contractId = row.contractId;
  if (!contractId) return { ...proposed, downgraded: false }; // exempt: nothing to deliver

  // Positive receipt wins by either signal: the delivery timestamp on the run,
  // or a deliverable already written onto the contract.
  const delivered =
    row.deliveredAt != null || contractCarriesDeliverable(contractId, deps);
  if (delivered) return { ...proposed, downgraded: false };

  return {
    status: 'failed',
    failureCause: 'no-deliverable',
    failureReason: NO_DELIVERABLE_REASON,
    downgraded: true,
  };
}

function contractCarriesDeliverable(contractId: ULID, deps: CompletionGateDeps): boolean {
  if (deps.contractHasDeliverable) return deps.contractHasDeliverable(contractId);
  try {
    const service = deps.contractService ?? new ContractService();
    return service.get(contractId)?.deliverable != null;
  } catch {
    // A read failure must not fabricate a completion — treat as not-delivered.
    return false;
  }
}
