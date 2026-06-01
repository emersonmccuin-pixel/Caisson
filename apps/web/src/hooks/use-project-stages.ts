// UI Spine step 3 — version-aware id-keyed store slice for project stages.
//
// Stages are always replaced atomically (no single-stage mutations), so all
// stages in a `stages-changed` batch share the same `rev` value. The hook
// maintains a Map<stageId, Stage> and discards any incoming batch whose rev
// is ≤ the stored rev of any existing stage (guards out-of-order WS delivery).
//
// List fn: fetches from GET /api/projects/:id (returns project including
// stages, each pre-stamped with rev by updateProjectStages on the server).

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Project, Stage, ULID } from '@/features/projects/client';
import { projectsApi } from '@/features/projects/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useLiveEvents } from '@/store/live-store';

function stagesRevOf(stages: Stage[]): number {
  return stages[0]?.rev ?? 0;
}

export function useProjectStages(
  project: Project | null,
  // Retained for signature stability; stage changes now come from the store.
  _events: WsEnvelope[],
): { stages: Stage[]; refetch: () => void } {
  // Seed = HTTP truth (project prop first for an instant paint, then the fetch).
  const [seed, setSeed] = useState<Stage[]>(() => project?.stages ?? []);

  const fetchAndSet = useCallback(
    (projectId: string) => {
      void (projectsApi.project(projectId as ULID) as unknown as Promise<Project>)
        .then((p) => setSeed(p.stages ?? []))
        .catch(() => {/* ignore */});
    },
    [],
  );

  // Initial fetch + project switch.
  useEffect(() => {
    if (!project) {
      setSeed([]);
      return;
    }
    setSeed(project.stages ?? []);
    fetchAndSet(project.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Slice 018 — overlay the latest `stage.list.changed` batch from the
  // identity-keyed live store. Stages are replaced atomically (every stage in a
  // batch shares one `rev`), so we pick the highest-rev batch across the seed
  // and any store frames. Rebuild-proof: no positional cursor over the timeline.
  const stageFrames = useLiveEvents('stage', project?.id ?? null);
  const stages = useMemo(() => {
    let chosen = seed;
    let chosenRev = stagesRevOf(seed);
    for (const ev of stageFrames) {
      const payload = ev.payload as { stagesRev?: number; stages?: Stage[] };
      const batch = payload.stages;
      if (!Array.isArray(batch) || batch.length === 0) continue;
      const rev = payload.stagesRev ?? stagesRevOf(batch);
      if (rev > chosenRev) {
        chosen = batch;
        chosenRev = rev;
      }
    }
    return [...chosen].sort((a, b) => a.order - b.order);
  }, [seed, stageFrames]);

  const refetch = useCallback(() => {
    if (!project) return;
    fetchAndSet(project.id);
  }, [project, fetchAndSet]);

  return { stages, refetch };
}
