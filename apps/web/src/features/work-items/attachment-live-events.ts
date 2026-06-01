// Slice 017 Fix 3 — canonical `attachment.changed` relay-frame consumption.
//
// The server now writes a durable live_outbox row for attachment create/delete
// (attachment.ts → announceAttachment) BESIDE the legacy bare
// `{type:'attachment-changed'}` broadcast. This helper lets the work-item
// attachment consumers also react to the canonical relay frame so they keep
// working after Phase C deletes the bare broadcast. Additive: the existing
// legacy-envelope branches stay intact for Phase A.

import { isAttachmentChangedLiveEvent } from '@pc/contracts';

/** Detect the relay `{type:'live-event', event}` frame carrying an
 *  `attachment.changed` event and yield `{ workItemId, reason }`, else null. */
export function attachmentChangedFromLiveFrame(
  env: unknown,
): { workItemId: string; reason: 'created' | 'deleted' } | null {
  if (!env || typeof env !== 'object') return null;
  const frame = env as { type?: unknown; event?: unknown };
  if (frame.type !== 'live-event') return null;
  if (!isAttachmentChangedLiveEvent(frame.event)) return null;
  return {
    workItemId: frame.event.payload.workItemId,
    reason: frame.event.payload.reason,
  };
}
