// Slice 010 — project-scoped Areas list. Fetches on project change; refetches
// the full list on ANY `area.changed` frame for this project.
//
// Areas are a handful per project, so a full refetch on every area frame is
// always correct and cheap — it sidesteps the single-vs-list payload mismatch
// (`created`/`patched` carry one `area`; `reordered` carries `areas[]`;
// `deleted` carries neither, and member items silently fall back to Uncaptured
// without per-item `work-item.changed` facts). Callers that show member counts
// must independently refetch their work-item list on the same frame.

import { useCallback, useEffect, useState } from 'react';

import { areasApi, type Area } from '@/features/areas/client';
import type { Project } from '@/features/projects/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useLiveEntitySignature } from '@/store/live-store';

export function useProjectAreas(
  project: Project | null,
  // Retained for signature stability; area changes now come from the live store.
  _events: WsEnvelope[],
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

  // Slice 018 — refetch the full list whenever the area frame set changes in the
  // identity-keyed live store. The signature flips only on a genuine area change
  // (rebuild-proof; no positional cursor over the chat timeline).
  const areaSig = useLiveEntitySignature('area', project?.id ?? null);
  useEffect(() => {
    if (project && areaSig) refetch();
  }, [areaSig, project, refetch]);

  return { areas, refetch };
}
