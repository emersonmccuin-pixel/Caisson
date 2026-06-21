// pc-pty-chat-436 — agent dossier hook.
//
// Fetches the dossier for a single work item from
// GET /api/projects/:projectId/work-items/:wiId/dossier, then refetches live
// whenever a `work-item-dossier.changed` frame lands for this project. Uses the
// identity-keyed live store signature (same pattern as useProjectAreas) so it is
// rebuild-proof and never requires a manual refresh.

import { useCallback, useEffect, useState } from 'react';

import { workItemsApi, type DossierRow } from '@/features/work-items/client';
import { useLiveEntitySignature } from '@/store/live-store';

export interface WorkItemDossierState {
  dossier: DossierRow | null;
  fresh: boolean;
  loading: boolean;
  error: string | null;
}

export function useWorkItemDossier(
  projectId: string,
  workItemId: string,
): WorkItemDossierState {
  const [dossier, setDossier] = useState<DossierRow | null>(null);
  const [fresh, setFresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    workItemsApi
      .getDossier(projectId, workItemId)
      .then((r) => {
        setDossier(r.dossier);
        setFresh(r.fresh);
        setLoading(false);
        setError(null);
      })
      .catch((e) => {
        setError((e as Error).message);
        setLoading(false);
      });
  }, [projectId, workItemId]);

  // Initial fetch + switch.
  useEffect(() => {
    setDossier(null);
    setFresh(true);
    setLoading(true);
    setError(null);
    refetch();
  }, [refetch]);

  // Live refetch on any `work-item-dossier.changed` frame for this project.
  // Signature is '' when no frames exist (falsy guard prevents spurious refetch).
  const dossierSig = useLiveEntitySignature('work-item-dossier', projectId);
  useEffect(() => {
    if (dossierSig) refetch();
  }, [dossierSig, refetch]);

  return { dossier, fresh, loading, error };
}
