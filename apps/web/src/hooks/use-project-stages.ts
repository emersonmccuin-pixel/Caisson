// UI Spine step 3 — version-aware id-keyed store slice for project stages.
//
// Stages are always replaced atomically (no single-stage mutations), so all
// stages in a `stages-changed` batch share the same `rev` value. The hook
// maintains a Map<stageId, Stage> and discards any incoming batch whose rev
// is ≤ the stored rev of any existing stage (guards out-of-order WS delivery).
//
// List fn: fetches from GET /api/projects/:id (returns project including
// stages, each pre-stamped with rev by updateProjectStages on the server).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isLiveEventFrame } from '@pc/contracts';

import type { Project, Stage, ULID } from '@/features/projects/client';
import { projectsApi } from '@/features/projects/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';

export function useProjectStages(
  project: Project | null,
  events: WsEnvelope[],
): { stages: Stage[]; refetch: () => void } {
  const [map, setMap] = useState<Map<string, Stage>>(() => new Map());
  const lastIdx = useRef(0);

  const fetchAndSet = useCallback(
    (projectId: string) => {
      void (projectsApi.project(projectId as ULID) as unknown as Promise<Project>)
        .then((p) => {
          const list: Stage[] = p.stages ?? [];
          setMap(new Map(list.map((s) => [s.id, s])));
        })
        .catch(() => {/* ignore */});
    },
    [],
  );

  // Initial fetch + project switch.
  useEffect(() => {
    if (!project) {
      setMap(new Map());
      lastIdx.current = 0;
      return;
    }
    // Seed from project prop first (instant — no network round-trip).
    setMap(new Map((project.stages ?? []).map((s) => [s.id, s])));
    lastIdx.current = events.length;
    fetchAndSet(project.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Slice 015b — scan new canonical `stage.list.changed` relay frames; apply
  // version-aware batch replacement. Stages are always replaced atomically, so
  // every stage in a batch shares the same `rev`.
  useEffect(() => {
    if (!project || events.length === 0) {
      lastIdx.current = events.length;
      return;
    }
    if (events.length < lastIdx.current) lastIdx.current = 0;
    const start = lastIdx.current;
    lastIdx.current = events.length;
    if (start >= events.length) return;

    for (let i = start; i < events.length; i++) {
      const env = events[i];
      // Slice 015b — match the canonical relay frame by entity. The server emits
      // domain stages (carry `order` + `rev`); the contract StageDto guard uses
      // `position`, so gate by entity/scope rather than the strict payload guard.
      if (!isLiveEventFrame(env) || env.event.entity !== 'stage') continue;
      if (env.event.projectId !== project.id) continue;
      const payload = env.event.payload as { stagesRev?: number; stages?: Stage[] };
      const stages = payload.stages;
      if (!Array.isArray(stages) || stages.length === 0) continue;
      const incomingRev = payload.stagesRev ?? (stages[0] as Stage).rev ?? 0;

      setMap((prev) => {
        // If any stored stage has a higher-or-equal rev, the batch is stale.
        if (incomingRev > 0) {
          for (const s of prev.values()) {
            if ((s.rev ?? 0) >= incomingRev) return prev; // stale — discard
          }
        }
        return new Map(stages.map((s) => [s.id, s]));
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, project?.id]);

  const refetch = useCallback(() => {
    if (!project) return;
    fetchAndSet(project.id);
  }, [project, fetchAndSet]);

  // Sort by order (preserves user-defined column sequence).
  const stages = useMemo(
    () => [...map.values()].sort((a, b) => a.order - b.order),
    [map],
  );

  return { stages, refetch };
}
