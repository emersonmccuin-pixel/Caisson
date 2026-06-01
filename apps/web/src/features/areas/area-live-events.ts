// T3.2b — pure decision helper for the area-delete → work-item refetch consumers
// (KanbanBoard, WorkItemsTable). Extracted so the version-keyed "fire once per
// NEW deleted frame" logic can be pinned under tsx --test without jsdom.

import { isAreaChangedLivePayload, type LiveEvent } from '@pc/contracts';

/** A live event's monotonic marker: numeric `version` when present, else the
 *  global string `cursor` (matches the T3.1 rich-link invalidator pattern). */
function markerOf(ev: LiveEvent): number | string {
  return ev.version ?? ev.cursor;
}

/** Walk the live store's `area` frames; return true iff a `deleted` frame's
 *  marker differs from what `seen` records for that area id (i.e. it's a NEW
 *  frame). Mutates `seen` to mark every observed frame (deleted or not) so a
 *  later non-deleted re-render can't re-trigger. Inert on created/patched/
 *  reordered and on a re-identified-but-unchanged array (store already
 *  version-dedups, so equality is the right "already processed" check). */
export function hasNewDeletedAreaFrame(
  events: LiveEvent[],
  seen: Map<string, number | string>,
): boolean {
  let fire = false;
  for (const ev of events) {
    if (!ev.entityId) continue;
    const marker = markerOf(ev);
    if (seen.get(ev.entityId) === marker) continue; // already processed
    seen.set(ev.entityId, marker);
    if (isAreaChangedLivePayload(ev.payload) && ev.payload.reason === 'deleted') {
      fire = true;
    }
  }
  return fire;
}
