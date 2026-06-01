// Evicts rich-link cache entries when a work-item or attachment changes, so a
// hovered preview re-fetches fresh data after its target mutates.
//
// T3.1 — driven off the identity-keyed live store (`useLiveEvents`), NOT a
// positional scan of the chat `events[]`. The old index-cursor scan missed
// frames after a chat-timeline rebuild during an active session. Here a
// version-keyed evicted-set ref evicts each entity exactly once per new
// version (not every render), and the store keying is rebuild-proof.
//
// Mount once at App / Shell level. Active-project scope only (the live store
// selectors are project-scoped); no cross-project rich-link preview exists.

import { useEffect, useRef } from 'react';

import type { LiveEvent } from '@pc/contracts';

import { useLiveEvents } from '@/store/live-store';
import {
  invalidateByAttachmentId,
  invalidateByWorkItemId,
} from '@/hooks/use-rich-link-data';

/** A live event's monotonic marker: its numeric `version` when present (rev'd
 *  entities), else the global string `cursor` (last-write-wins entities). */
function markerOf(ev: LiveEvent): number | string {
  return ev.version ?? ev.cursor;
}

/** Pure: given a list of live events and the per-entityId markers already
 *  evicted, return the ids whose marker is new (so eviction happens once per
 *  genuine change) and the updated marker map to record. Exported for tests. */
export function collectEvictions(
  events: readonly LiveEvent[],
  evicted: Map<string, number | string>,
): { ids: string[]; next: Map<string, number | string> } {
  const ids: string[] = [];
  const next = new Map(evicted);
  for (const ev of events) {
    if (!ev.entityId) continue;
    const marker = markerOf(ev);
    if (next.get(ev.entityId) === marker) continue;
    next.set(ev.entityId, marker);
    ids.push(ev.entityId);
  }
  return { ids, next };
}

export function useRichLinkInvalidator(projectId: string | null): void {
  const wiEvents = useLiveEvents('work-item', projectId);
  const attEvents = useLiveEvents('attachment', projectId);
  // entityId → last-evicted marker. Survives re-renders; identity-keyed so a
  // chat-timeline rebuild can't make us miss or double-fire.
  const wiEvicted = useRef<Map<string, number | string>>(new Map());
  const attEvicted = useRef<Map<string, number | string>>(new Map());

  useEffect(() => {
    const { ids, next } = collectEvictions(wiEvents, wiEvicted.current);
    wiEvicted.current = next;
    for (const id of ids) invalidateByWorkItemId(id);
  }, [wiEvents]);

  useEffect(() => {
    const { ids, next } = collectEvictions(attEvents, attEvicted.current);
    attEvicted.current = next;
    for (const id of ids) invalidateByAttachmentId(id);
  }, [attEvents]);
}
