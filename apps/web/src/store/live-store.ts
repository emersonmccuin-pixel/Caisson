// PROTOTYPE (slice 018 spike) — the single client-side live-event store.
//
// THE FOUNDATIONAL IDEA: relay `live-event` frames are applied here, keyed by
// (entity, entityId) with per-entity `version` dedup — NOT scanned positionally
// off the chat timeline. Identity+version keying is rebuild-proof: it survives
// the chat-session timeline being re-derived (session-replay/snapshot), which is
// what makes the legacy per-view index-cursor scans miss frames during active
// sessions.
//
// Fed directly from the WS message handler (use-project-ws) for EVERY live-event
// frame, independent of the chat reducer. Views subscribe by entity via a
// selector (here: useLiveWorkItems) and get an always-current, deduped snapshot.
//
// Spike scope: work-item only + fed beside the legacy path (reconcile-first).
// Slice 018 generalizes the selector to every entity and deletes the per-view
// scans.

import { useMemo } from 'react';
import { create } from 'zustand';

import { isLiveEventFrame, isWorkItemChangedLivePayload, type LiveEvent } from '@pc/contracts';
import type { WorkItem } from '@/features/work-items/client';

interface LiveStore {
  /** key: `${entity}::${entityId}` → latest version-deduped LiveEvent. */
  byKey: Map<string, LiveEvent>;
  /** Apply one WS envelope; no-op unless it's a relay live-event frame. */
  applyEnvelope: (env: unknown) => void;
}

export const useLiveStore = create<LiveStore>((set, get) => ({
  byKey: new Map(),
  applyEnvelope: (env) => {
    if (!isLiveEventFrame(env)) return;
    const ev = env.event;
    if (!ev.entityId) return;
    const key = `${ev.entity}::${ev.entityId}`;
    const prev = get().byKey.get(key);
    // Version dedup: a numeric version that is not newer than what we hold is a
    // stale/duplicate delivery. A null version (entities without a rev) always
    // applies — last-write-wins.
    if (prev && typeof ev.version === 'number' && (prev.version ?? -1) >= ev.version) {
      return;
    }
    const next = new Map(get().byKey);
    next.set(key, ev);
    set({ byKey: next });
  },
}));

/** Latest live snapshot of every work item the store has seen for this project,
 *  including soft-deleted ones (carry `deletedAt` so the view can drop them). */
export function useLiveWorkItems(projectId: string): WorkItem[] {
  const byKey = useLiveStore((s) => s.byKey);
  return useMemo(() => {
    const out: WorkItem[] = [];
    for (const ev of byKey.values()) {
      if (ev.entity !== 'work-item' || ev.projectId !== projectId) continue;
      if (!isWorkItemChangedLivePayload(ev.payload)) continue;
      const wi = ev.payload.workItem;
      if (wi) out.push(wi as unknown as WorkItem);
    }
    return out;
  }, [byKey, projectId]);
}
