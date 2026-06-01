// UI Spine step 3 / slice 015b-tail — id-keyed store slice for pods.
//
// Pod (agent-definition) changes are DB-owned facts. The server writes a
// `pod.changed` live_outbox row in-txn on every pod mutation and the relay fans
// the canonical `{type:'live-event', event}` frame: a GLOBAL frame for global
// pods (reaches every project socket → the stock-globals row refreshes) and a
// PROJECT frame for project pods. We refetch the roster on any matching frame
// (the payload is minimal by design — the list endpoint is the source of truth).
//
// Scope filter for the roster: only project-scope pods for THIS project + stock
// globals. The list endpoint already applies that filter (listProjectVisibleAgents).

import { useEffect, useRef, useMemo } from 'react';
import { isPodChangedLiveEventFrame } from '@pc/contracts';
import type { Project, ULID } from '@/features/projects/client';
import { agentsApi, type Pod } from '@/features/agents/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useResourceList } from '@/hooks/use-resource-list';

export function useProjectPods(
  project: Project | null,
  events: WsEnvelope[],
): { pods: Pod[]; refetch: () => void } {
  // useResourceList drives the HTTP list + on-(re)connect reconciliation. We do
  // NOT wire a live-event extractor here: the pod.changed payload is minimal, so
  // every matching frame triggers a wholesale refetch (below) instead.
  const { records, refetch } = useResourceList<Pod>(project, events, {
    getId: (pod) => pod.id,
    isTerminal: () => false,
    dropOnTerminal: false,
    getVersion: (pod) => pod.rev,
    list: (projectId) => agentsApi.listPods(projectId as ULID),
  });

  // Refetch on any pod.changed relay frame (created / updated / deleted). Scan
  // every new envelope since the last processed index so a frame buried in a
  // batched flush isn't missed (UI spine).
  const scanIdx = useRef(0);
  useEffect(() => {
    if (events.length < scanIdx.current) scanIdx.current = 0;
    const start = scanIdx.current;
    scanIdx.current = events.length;
    if (start >= events.length) return;
    for (let i = start; i < events.length; i++) {
      const env = events[i];
      if (env && isPodChangedLiveEventFrame(env)) {
        refetch();
        return;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  // Sort alphabetically — mirrors the original hook.
  const pods = useMemo(
    () => [...records].sort((a, b) => a.name.localeCompare(b.name)),
    [records],
  );

  return { pods, refetch };
}
