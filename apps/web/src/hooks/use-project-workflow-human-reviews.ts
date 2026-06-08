// T5 — run-state-backed "Waiting on you" signal for the Activity Panel.
//
// SOURCE: the durable `workflow.review.changed` live event
// (entity: 'workflow-review', entityId: runId, payload: { flavor, state }).
// This is the SAME fact the server writes via commitReviewChange when a review
// gate opens (state:'pending') or resolves (state:'approved'|'rejected').
//
// Two layers (same pattern as useResourceList):
//   1. HTTP seed — fetches open human reviews on mount / project switch /
//      WS reconnect via /workflow-v2/pending-human-reviews.
//   2. Live overlay — applies workflow.review.changed events from the live
//      store on top: pending → add runId; approved|rejected → remove runId.
//      The store is keyed (entity, entityId=runId) + version-deduped so only
//      the newest event per run is held; a resolution always has a higher rev
//      than the preceding pending event, so it correctly overwrites it.
//
// The result is a Set<runId> of runs currently paused at a human gate.
// The caller guards with `run.status === 'paused'` to handle cancellations
// that race between the seed fetch and the live event delivery.

import { useEffect, useMemo, useState } from 'react';

import { isWorkflowReviewChangedLivePayload } from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import { workflowsApi } from '@/features/workflows/client';
import { useLiveEvents } from '@/store/live-store';
import { useWsEpoch } from '@/store/ws-epoch';

// Pure derivation lives in a separate file so node:test can import it
// without loading React or zustand.
export { applyReviewChange } from './workflow-human-reviews-util.ts';
import { applyReviewChange } from './workflow-human-reviews-util.ts';

// ── Hook ──────────────────────────────────────────────────────────────────────

/** Returns the set of runIds currently paused at a human review gate. */
export function useProjectWorkflowHumanReviews(
  project: Project | null,
): ReadonlySet<string> {
  const [seed, setSeed] = useState<ReadonlySet<string>>(() => new Set());
  const wsEpoch = useWsEpoch((s) =>
    project ? (s.byProject[project.id] ?? 0) : 0,
  );

  // Seed: refetch on mount, project change, or WS reconnect.
  useEffect(() => {
    if (!project) {
      setSeed(new Set());
      return;
    }
    let cancelled = false;
    void workflowsApi.listPendingHumanReviews(project.id).then((res) => {
      if (cancelled) return;
      setSeed(new Set(res.reviews.map((r) => r.runId)));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, wsEpoch]);

  // Live overlay: apply review-changed frames on top of the seed.
  const liveEvents = useLiveEvents('workflow-review', project?.id ?? null);

  return useMemo(() => {
    let result: ReadonlySet<string> = seed;
    for (const ev of liveEvents) {
      if (!isWorkflowReviewChangedLivePayload(ev.payload)) continue;
      result = applyReviewChange(result, ev.payload);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, liveEvents]);
}
