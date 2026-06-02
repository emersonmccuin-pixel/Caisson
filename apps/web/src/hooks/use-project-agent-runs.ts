// Activity-panel feeder for the "Running agents" region.
//
// Section 18.10: a thin wrapper around the generic `useResourceList<T>`.
// Slice 015b: now consumes the canonical relay `live-event` frame
// (entity `agent-run`, `agent.run.changed`) instead of the legacy
// `agent-run-changed` envelope. The frame's payload carries the full
// `AgentRunDto` snapshot with the current rev (apply-if-full-record — no
// refetch needed). The local map drops terminal rows on the per-frame branch
// and then refetches, since the server's list endpoint filters terminal rows
// out (running-agents view only).

import { isAgentRunChangedLivePayload } from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import { agentRunsApi, type AgentRunRecord } from '@/features/agent-runs/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useResourceList } from '@/hooks/use-resource-list';

const TERMINAL = new Set<AgentRunRecord['status']>([
  'completed',
  'failed',
  'cancelled',
]);

export function useProjectAgentRuns(
  project: Project | null,
  events: WsEnvelope[],
): { runs: AgentRunRecord[] } {
  const { records } = useResourceList<AgentRunRecord>(project, events, {
    liveEventEntity: 'agent-run',
    extractFromLiveEvent: (event, projectId) => {
      if (!isAgentRunChangedLivePayload(event.payload)) return null;
      const run = event.payload.run;
      if (run.projectId !== projectId) return null;
      // AgentRunDto → legacy AgentRunRecord: re-add the constant `wait:false`.
      // T2.2 — stamp `stalled` from the watchdog warn frame; any other reason
      // (incl. the `reconciled` un-stall) clears it. Both carry a bumped rev so
      // the version-deduped live store accepts the overlay.
      return {
        ...run,
        wait: false,
        stalled: event.payload.reason === 'stalled',
      } as AgentRunRecord;
    },
    getId: (r) => r.runId,
    isTerminal: (r) => TERMINAL.has(r.status),
    dropOnTerminal: true,
    getVersion: (r) => r.rev ?? 0,
    list: (projectId) => agentRunsApi.listAgentRuns(projectId),
  });
  return { runs: records };
}
