// UI Spine step 2 — Activity-panel feeder for v2 workflow runs.
//
// Slice 015b: now consumes the canonical relay `live-event` frame (entity
// `workflow-run`, `workflow.run.changed`) instead of the legacy
// `workflow-v2-run-changed` envelope. The run-change frame's payload carries the
// full `WorkflowRunDto` snapshot with the current rev (apply-if-full-record), so
// this:
//   - patches one run in place via the id-keyed Map on each frame
//   - discards frames whose `rev` ≤ stored `rev` (out-of-order WS)
//   - refetches the list only on mount, project switch, or reconnect/replay reset
//
// `WorkflowRunDto.workflowSlug` maps to `V2RunSummary.workflowId` (the slug IS
// the workflow id — legacy naming); the rest of the DTO is a superset.

import { isWorkflowRunChangedLivePayload, type WorkflowRunDto } from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import { workflowsApi, type V2RunStatus, type V2RunSummary } from '@/features/workflows/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useResourceList } from '@/hooks/use-resource-list';

const TERMINAL = new Set<V2RunStatus>(['completed', 'failed', 'cancelled']);

function runDtoToSummary(run: WorkflowRunDto): V2RunSummary {
  return {
    id: run.id,
    workflowId: run.workflowSlug,
    workflowName: run.workflowName,
    projectId: run.projectId,
    workItemId: run.workItemId,
    trigger: run.trigger,
    stageId: run.stageId,
    status: run.status as V2RunStatus,
    worktreePath: run.worktreePath,
    lastReason: run.lastReason,
    rev: run.rev,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}

export function useProjectWorkflowV2Runs(
  project: Project | null,
  events: WsEnvelope[],
): { runs: V2RunSummary[]; refetch: () => void } {
  const { records, refetch } = useResourceList<V2RunSummary>(project, events, {
    liveEventEntity: 'workflow-run',
    extractFromLiveEvent: (event, projectId) => {
      if (!isWorkflowRunChangedLivePayload(event.payload)) return null;
      const run = event.payload.run;
      // Run-change frames always carry the full run snapshot; a frame without it
      // (defensive) can't be applied — skip and let the next frame / refetch fix.
      if (!run || run.projectId !== projectId) return null;
      return runDtoToSummary(run);
    },
    getId: (r) => r.id,
    isTerminal: (r) => TERMINAL.has(r.status),
    // Workflow runs remain in the list at terminal (the "Failed recently" and
    // "Waiting on you" regions both consume terminal runs). The list endpoint
    // returns all runs (not just active ones), so we keep them in the Map.
    dropOnTerminal: false,
    getVersion: (r) => r.rev,
    list: (projectId) =>
      workflowsApi.listV2WorkflowRuns(projectId).then((r) => r.runs),
  });

  return { runs: records, refetch };
}
