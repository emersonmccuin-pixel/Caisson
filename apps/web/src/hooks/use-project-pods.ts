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

import { useEffect, useMemo } from 'react';
import type { Project, ULID } from '@/features/projects/client';
import { agentsApi, type Pod } from '@/features/agents/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useResourceList } from '@/hooks/use-resource-list';
import { useLiveEntitySignature } from '@/store/live-store';

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

  // Slice 018 — refetch the roster whenever the pod frame set changes in the
  // identity-keyed live store (created / updated / deleted). Global pod frames
  // carry projectId null and reach every project, which the signature includes.
  const podSig = useLiveEntitySignature('pod', project?.id ?? null);
  useEffect(() => {
    if (podSig) refetch();
  }, [podSig, refetch]);

  // Sort alphabetically — mirrors the original hook.
  const pods = useMemo(
    () => [...records].sort((a, b) => a.name.localeCompare(b.name)),
    [records],
  );

  return { pods, refetch };
}
