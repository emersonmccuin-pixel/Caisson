// Slice 018 — the single client-side live-event store.
//
// THE FOUNDATIONAL IDEA: relay `live-event` frames are applied here, keyed by
// (entity, entityId) with per-entity `version` dedup — NOT scanned positionally
// off the chat timeline. Identity+version keying is rebuild-proof: it survives
// the chat-session timeline being re-derived (session-replay/snapshot), which is
// what made the legacy per-view index-cursor scans miss frames during active
// sessions (the long-standing "need to refresh" staleness).
//
// Fed directly from the WS message handler (use-project-ws) for EVERY live-event
// frame, independent of the chat reducer. Views subscribe by entity via the
// generic `useLiveEvents(entity, projectId)` selector (or a typed convenience
// wrapper like `useLiveWorkItems`) and get an always-current, deduped snapshot.

import { useMemo } from 'react';
import { create } from 'zustand';

import {
  isLiveEventFrame,
  isWorkItemChangedLivePayload,
  type LiveEvent,
  type LiveEventEntity,
} from '@pc/contracts';
import type { WorkItem } from '@/features/work-items/client';

interface LiveStore {
  /** key: `${entity}::${entityId}` → latest version-deduped LiveEvent. */
  byKey: Map<string, LiveEvent>;
  /** Apply one WS envelope; no-op unless it's a relay live-event frame. */
  applyEnvelope: (env: unknown) => void;
  /** Drop everything. Wired to `live-reset` (the below-floor catch-up gap) so a
   *  stale frame can never re-merge over freshly reseeded HTTP truth. */
  clearAll: () => void;
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
  clearAll: () => set({ byKey: new Map() }),
}));

/** Generic selector: every live event the store currently holds for `entity`
 *  that is in-scope for `projectId` — project-scoped frames matching the project
 *  PLUS global-scope frames (`projectId === null`, e.g. a global workflow
 *  definition) which legitimately affect every project. Returns the latest
 *  version-deduped frame per entity id. Memoized on the store map identity, so
 *  it only recomputes when a frame actually lands. */
export function useLiveEvents(
  entity: LiveEventEntity | null,
  projectId: string | null,
): LiveEvent[] {
  const byKey = useLiveStore((s) => s.byKey);
  return useMemo(() => {
    if (!entity || !projectId) return [];
    const out: LiveEvent[] = [];
    for (const ev of byKey.values()) {
      if (ev.entity !== entity) continue;
      if (ev.projectId !== null && ev.projectId !== projectId) continue;
      out.push(ev);
    }
    return out;
  }, [byKey, entity, projectId]);
}

/** Latest live snapshot of every work item the store has seen for this project,
 *  including soft-deleted ones (carry `deletedAt` so the view can drop them). */
export function useLiveWorkItems(projectId: string): WorkItem[] {
  const events = useLiveEvents('work-item', projectId);
  return useMemo(() => {
    const out: WorkItem[] = [];
    for (const ev of events) {
      if (!isWorkItemChangedLivePayload(ev.payload)) continue;
      const wi = ev.payload.workItem;
      if (wi) out.push(wi as unknown as WorkItem);
    }
    return out;
  }, [events]);
}
