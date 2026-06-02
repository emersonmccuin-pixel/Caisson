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
  /** T2.3-C — cold-load HTTP seed: merge raw `LiveEvent[]` (from a current-state
   *  snapshot endpoint, e.g. `/api/agent-host/health`) with the SAME
   *  (entity,entityId)+version dedup as `applyEnvelope`, so a fresh reload shows
   *  current global state immediately instead of waiting for the next WS
   *  transition. (The replay route can't seed cold-load — it's catch-up-from-
   *  cursor and returns nothing without a prior cursor.) */
  seedEvents: (events: readonly LiveEvent[]) => void;
  /** Drop everything. Wired to `live-reset` (the below-floor catch-up gap) so a
   *  stale frame can never re-merge over freshly reseeded HTTP truth. */
  clearAll: () => void;
}

/** Merge one raw `LiveEvent` into `byKey` with version dedup. Returns the new
 *  map only when the event actually applies, else `null` (no-op). Shared by the
 *  WS-frame path (`applyEnvelope`) and the cold-load seed (`seedEvents`). */
function mergeEvent(byKey: Map<string, LiveEvent>, ev: LiveEvent): Map<string, LiveEvent> | null {
  if (!ev.entityId) return null;
  const key = `${ev.entity}::${ev.entityId}`;
  const prev = byKey.get(key);
  // Version dedup: a numeric version that is not newer than what we hold is a
  // stale/duplicate delivery. A null version (entities without a rev) always
  // applies — last-write-wins.
  if (prev && typeof ev.version === 'number' && (prev.version ?? -1) >= ev.version) {
    return null;
  }
  const next = new Map(byKey);
  next.set(key, ev);
  return next;
}

export const useLiveStore = create<LiveStore>((set, get) => ({
  byKey: new Map(),
  applyEnvelope: (env) => {
    if (!isLiveEventFrame(env)) return;
    const next = mergeEvent(get().byKey, env.event);
    if (next) set({ byKey: next });
  },
  seedEvents: (events) => {
    let map = get().byKey;
    let changed = false;
    for (const ev of events) {
      const next = mergeEvent(map, ev);
      if (next) {
        map = next;
        changed = true;
      }
    }
    if (changed) set({ byKey: map });
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

/** A stable signature of the frame set the store holds for `entity` in
 *  `projectId` scope (project + global). The string changes ONLY when that
 *  entity's frames change (a new id, or a newer version/cursor for an existing
 *  id) — so a refetch-only consumer can key an effect off it and refetch
 *  exactly once per genuine change, never on an unrelated entity's frame.
 *  Selected via zustand so the component re-renders only when the value flips. */
export function useLiveEntitySignature(
  entity: LiveEventEntity | null,
  projectId: string | null,
): string {
  return useLiveStore((s) => {
    if (!entity || !projectId) return '';
    let sig = '';
    for (const ev of s.byKey.values()) {
      if (ev.entity !== entity) continue;
      if (ev.projectId !== null && ev.projectId !== projectId) continue;
      // version when present (versioned entities), else the monotonic global
      // cursor (last-write-wins entities) — both advance on a newer frame.
      sig += `${ev.entityId}:${ev.version ?? ev.cursor};`;
    }
    return sig;
  });
}

/** T1.1 — every global-scope live event the store holds for `entity`
 *  (`scope === 'global'`, i.e. `projectId === null`). Distinct from
 *  `useLiveEvents`, whose null-projectId early-return is load-bearing for the
 *  project views. This is the project-less selector T3.1 will also reuse. */
export function useLiveGlobalEvents(entity: LiveEventEntity | null): LiveEvent[] {
  const byKey = useLiveStore((s) => s.byKey);
  return useMemo(() => {
    if (!entity) return [];
    const out: LiveEvent[] = [];
    for (const ev of byKey.values()) {
      if (ev.entity !== entity) continue;
      if (ev.projectId !== null) continue;
      out.push(ev);
    }
    return out;
  }, [byKey, entity]);
}

/** Stable signature of the global-scope frame set for `entity`; flips only when
 *  a global frame for that entity lands (new id, or newer version/cursor). */
export function useLiveGlobalSignature(entity: LiveEventEntity | null): string {
  return useLiveStore((s) => {
    if (!entity) return '';
    let sig = '';
    for (const ev of s.byKey.values()) {
      if (ev.entity !== entity) continue;
      if (ev.projectId !== null) continue;
      sig += `${ev.entityId}:${ev.version ?? ev.cursor};`;
    }
    return sig;
  });
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
