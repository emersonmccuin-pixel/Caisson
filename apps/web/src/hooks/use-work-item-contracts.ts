// Slice 013 — a work item's contract timeline (the "work log"), live.
//
// Seeds from the HTTP fetch (oldest-first) on mount / work-item switch, then
// overlays `contract.changed` frames from the identity-keyed live store the SAME
// way other entities do (NO positional chat-timeline scan — slice 018 removed
// that anti-pattern). The store keys frames by (entity,entityId)+version, so the
// overlay is rebuild-proof. `mergeContractsWithLive` does the id+version merge.

import { useEffect, useMemo, useState } from 'react';

import type { Contract } from '@/features/contracts/client';
import { contractsApi } from '@/features/contracts/client';
import { contractFromLiveEvent, mergeContractsWithLive } from '@/features/contracts/work-log';
import { useLiveEvents } from '@/store/live-store';

export function useWorkItemContracts(
  projectId: string,
  workItemId: string,
): { contracts: Contract[]; loading: boolean; error: string | null } {
  const [seed, setSeed] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initial fetch + work-item switch.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    contractsApi
      .getWorkItemContracts(workItemId)
      .then((list) => {
        if (!cancelled) setSeed(list);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workItemId]);

  // Live overlay — every contract frame this project holds, adapted to a
  // Contract and filtered to this work item.
  const contractEvents = useLiveEvents('contract', projectId);
  const live = useMemo(() => {
    const out: Contract[] = [];
    for (const ev of contractEvents) {
      const c = contractFromLiveEvent(ev, projectId);
      if (c && c.workItemId === workItemId) out.push(c);
    }
    return out;
  }, [contractEvents, projectId, workItemId]);

  const contracts = useMemo(() => mergeContractsWithLive(seed, live), [seed, live]);

  return { contracts, loading, error };
}
