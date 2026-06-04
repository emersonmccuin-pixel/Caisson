// M6 slice C — FD-11: cancel a workflow run FOR REAL (the gateway's cancelRun
// existed since M3a with no production caller; the executor polled isCancelled
// for a setter that never fired). One service, three callers: the cancel
// route, pc_cancel_workflow_run, and the workflow soft-delete `?cancel=1` path
// (which used to write status directly — skipping the `workflow_cancelled`
// diary line and leaving child agent runs running).
//
// Cascade: gateway.cancelRun (status + fact + diary, one txn) → cancel every
// non-terminal CHILD agent run (found by the dispatch door's synthetic
// dispatcher id `wf-<runId last8>-<nodeId>-…`) via the same doors the agent
// cancel route uses: registry handle teardown + host `cancel` command. The
// executor's isCancelled poll sees the status between layers and stops.

import type { ULID } from '@pc/domain';
import {
  listNonTerminalAgentRuns,
  workflowRunsV2Repo,
} from '@pc/db';
import { WorkflowRunMutationGateway } from '@pc/app-services';
import { getActiveRunRegistry } from './agent-active-runs.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';

const gateway = new WorkflowRunMutationGateway();

export type CancelWorkflowRunResult =
  | { ok: true; runId: ULID; cancelledChildren: ULID[] }
  | { ok: false; code: 'not-found' | 'already-terminal'; error: string };

export async function cancelWorkflowRunCascade(input: {
  projectId: ULID;
  runId: ULID;
  getHostConnection?: () => AgentHostReattachClient | null;
}): Promise<CancelWorkflowRunResult> {
  const run = workflowRunsV2Repo.getRunForProject(input.runId, input.projectId);
  if (!run) return { ok: false, code: 'not-found', error: `unknown run: ${input.runId}` };
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return {
      ok: false,
      code: 'already-terminal',
      error: `run is already ${run.status}`,
    };
  }

  // Status + workflow.run.changed fact + workflow_cancelled diary line, one txn.
  gateway.cancelRun({ projectId: input.projectId, runId: input.runId });

  // Cascade to in-flight child agent runs (the workers this run dispatched).
  const prefix = `wf-${input.runId.slice(-8)}-`;
  const children = listNonTerminalAgentRuns().filter(
    (r) => r.projectId === input.projectId && r.dispatcherSessionId.startsWith(prefix),
  );
  const registry = getActiveRunRegistry();
  const host = input.getHostConnection?.() ?? null;
  const cancelledChildren: ULID[] = [];
  for (const child of children) {
    const entry = registry.get(child.id);
    if (entry) entry.run.cancel();
    if (host && child.pid === null) {
      try {
        await Promise.resolve(host.sendCommand({ type: 'cancel', runId: child.id }));
      } catch {
        /* swallow — the host's own terminal event / reconcile sweep is the net */
      }
    }
    cancelledChildren.push(child.id);
  }

  return { ok: true, runId: input.runId, cancelledChildren };
}
