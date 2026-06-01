// Slice 010 — project-scoped Areas list. Fetches on project change; refetches
// the full list on ANY `area.changed` frame for this project.
//
// Areas are a handful per project, so a full refetch on every area frame is
// always correct and cheap — it sidesteps the single-vs-list payload mismatch
// (`created`/`patched` carry one `area`; `reordered` carries `areas[]`;
// `deleted` carries neither, and member items silently fall back to Uncaptured
// without per-item `work-item.changed` facts). Callers that show member counts
// must independently refetch their work-item list on the same frame.

import { useCallback, useEffect, useRef, useState } from 'react';

import { isAreaChangedLiveEventFrame } from '@pc/contracts';

import { areasApi, type Area } from '@/features/areas/client';
import type { Project } from '@/features/projects/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';

export function useProjectAreas(
  project: Project | null,
  events: WsEnvelope[],
): { areas: Area[]; refetch: () => void } {
  const [areas, setAreas] = useState<Area[]>([]);

  const refetch = useCallback(() => {
    if (!project) {
      setAreas([]);
      return;
    }
    void areasApi
      .listAreas(project.id)
      .then(setAreas)
      .catch(() => {
        /* leave the current list on transient failure */
      });
  }, [project?.id]);

  // Initial fetch + project switch.
  useEffect(() => {
    setAreas([]);
    refetch();
  }, [refetch]);

  // Scan every new envelope since the last processed index — refetch on any
  // area.changed frame for this project.
  const lastIdx = useRef(0);
  useEffect(() => {
    if (!project) {
      lastIdx.current = events.length;
      return;
    }
    if (events.length < lastIdx.current) lastIdx.current = 0;
    const start = lastIdx.current;
    lastIdx.current = events.length;
    if (start >= events.length) return;
    for (let i = start; i < events.length; i++) {
      const env = events[i];
      if (isAreaChangedLiveEventFrame(env) && env.event.projectId === project.id) {
        refetch();
        break;
      }
    }
  }, [events, project?.id, refetch]);

  return { areas, refetch };
}
