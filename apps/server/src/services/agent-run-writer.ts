// Slice 005 — announcing write-door for agent_runs UI-relevant transitions.
//
// The single durable seam between the scattered agent-run broadcast sites and
// the WS hub. Every site that used to build a v1 `agent-run-changed` record +
// `broadcast({type:'agent-run-changed', record})` now routes through the
// AgentRunMutationGateway, which writes the repo change + a durable live_outbox
// row in ONE transaction. After commit we fan out BOTH the canonical
// {type:'live-event'} frame (new clients) and the legacy `agent-run-changed`
// envelope (compat) via the supplied per-project `broadcast`.
//
// The `broadcast` callback is `(event: unknown) => void` scoped to a single
// project (callers pass a `broadcastTo(projectId, ...)` lambda or the factory's
// per-run broadcast shim).

import {
  AgentRunMutationGateway,
  type AgentRunChangedPublication,
} from '@pc/app-services';
import {
  buildLiveEventFrame,
  toLegacyAgentRunRecord,
  type AgentRunChangedReason,
} from '@pc/contracts';
import type { AgentRunFailureCause, ULID } from '@pc/domain';
import type { CreatePendingAskInput } from '@pc/db';

export type AgentRunBroadcast = (event: unknown) => void;

const gateway = new AgentRunMutationGateway();

/** Fan out a gateway publication: canonical live-event frame + legacy envelope.
 *  No-ops on a null publication (no row / replayed no-op / already terminal). */
export function fanoutAgentRunChange(
  pub: AgentRunChangedPublication | null,
  broadcast: AgentRunBroadcast | undefined,
): void {
  if (!pub || !broadcast) return;
  broadcast(buildLiveEventFrame(pub.liveEvent));
  broadcast({ type: 'agent-run-changed', record: toLegacyAgentRunRecord(pub.run) });
}

/** Re-read the row + announce a versioned snapshot through the durable outbox.
 *  Used by the state/host/reconcile sites where the DB write already happened.
 *  Builds the fact from the POST-write row (correct rev). */
export function announceAgentRunChange(
  input: {
    runId: ULID;
    reason: AgentRunChangedReason;
    worktreeDir?: string;
    startedAt?: number;
    pendingAskId?: ULID | null;
  },
  broadcast: AgentRunBroadcast | undefined,
): void {
  fanoutAgentRunChange(gateway.announceRunChange(input), broadcast);
}

export function pauseAgentRun(
  input: { pendingAsk: CreatePendingAskInput; worktreeDir?: string; startedAt?: number },
  broadcast: AgentRunBroadcast | undefined,
): AgentRunChangedPublication {
  const pub = gateway.pauseRun(input);
  fanoutAgentRunChange(pub, broadcast);
  return pub;
}

export function answerAndResumeAgentRun(
  input: {
    pendingAskId: ULID;
    agentRunId: ULID;
    answer: string;
    answeredBy: 'orchestrator' | 'user';
    now: number;
    podRevisionAtResume: string | null;
    worktreeDir?: string;
    startedAt?: number;
  },
  broadcast: AgentRunBroadcast | undefined,
): AgentRunChangedPublication | null {
  const pub = gateway.answerAndResume(input);
  fanoutAgentRunChange(pub, broadcast);
  return pub;
}

export function cancelAgentRun(
  input: {
    runId: ULID;
    now: number;
    failureCause?: AgentRunFailureCause | null;
    failureReason?: string | null;
    cancelOpenAsk?: ULID | null;
    worktreeDir?: string;
    startedAt?: number;
  },
  broadcast: AgentRunBroadcast | undefined,
): AgentRunChangedPublication | null {
  const pub = gateway.cancelRun(input);
  fanoutAgentRunChange(pub, broadcast);
  return pub;
}

export function commitAgentRunTerminal(
  input: {
    runId: ULID;
    status: 'completed' | 'failed' | 'cancelled';
    result: string | null;
    failureCause: AgentRunFailureCause | null;
    failureReason: string | null;
    completedAt: number;
    worktreeDir?: string;
    startedAt?: number;
  },
  broadcast: AgentRunBroadcast | undefined,
): AgentRunChangedPublication | null {
  const pub = gateway.commitTerminal(input);
  fanoutAgentRunChange(pub, broadcast);
  return pub;
}

export { gateway as agentRunMutationGateway };
