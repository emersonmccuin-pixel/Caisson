// Slice 017 Fix 3 — canonical `attachment.changed` relay-frame consumption.
//
// The server now writes a durable live_outbox row for attachment create/delete
// (attachment.ts → announceAttachment) BESIDE the legacy bare
// `{type:'attachment-changed'}` broadcast. This helper lets the work-item
// attachment consumers also react to the canonical relay frame so they keep
// working after Phase C deletes the bare broadcast. Additive: the existing
// legacy-envelope branches stay intact for Phase A.

import {
  isAttachmentChangedLivePayload,
  type LiveEvent,
} from '@pc/contracts';

function markerOf(ev: LiveEvent): number | string {
  return ev.version ?? ev.cursor;
}

/** T3.2c — store-driven attachment refetch trigger. True iff `events` (from
 *  `useLiveEvents('attachment', projectId)`) holds a NEW frame (newer than
 *  `seen` records) for `workItemId`; mutates `seen` so a later unrelated
 *  re-render can't re-fire. Attachments have null version → key on cursor.
 *  Mirrors the T3.2b per-entity pattern (hasNewPodFrameFor). */
export function hasNewAttachmentFrameFor(
  events: LiveEvent[],
  workItemId: string,
  seen: Map<string, number | string>,
): boolean {
  let fire = false;
  for (const ev of events) {
    if (!ev.entityId) continue;
    const marker = markerOf(ev);
    if (seen.get(ev.entityId) === marker) continue;
    seen.set(ev.entityId, marker);
    if (isAttachmentChangedLivePayload(ev.payload) && ev.payload.workItemId === workItemId) {
      fire = true;
    }
  }
  return fire;
}
