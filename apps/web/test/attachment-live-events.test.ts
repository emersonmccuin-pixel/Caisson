import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasNewAttachmentFrameFor } from '../src/features/work-items/attachment-live-events';
import type { LiveEvent } from '@pc/contracts';

// Minimal attachment live-event frame (attachments have null version → cursor keys it).
function frame(entityId: string, cursor: string, workItemId: string): LiveEvent {
  return {
    id: entityId,
    entity: 'attachment',
    entityId,
    scope: 'project',
    projectId: 'p1',
    version: null,
    cursor,
    type: 'attachment.changed',
    // `attachment` omitted — the payload guard treats it as optional; the
    // helper only reads workItemId. Production frames carry the full DTO.
    payload: { reason: 'created', workItemId },
  } as unknown as LiveEvent;
}

test('fires once for a new attachment frame matching the work item', () => {
  const seen = new Map<string, number | string>();
  assert.equal(hasNewAttachmentFrameFor([frame('a1', 'c1', 'wi-1')], 'wi-1', seen), true);
  // Same frame, re-passed (re-render) → no re-fire.
  assert.equal(hasNewAttachmentFrameFor([frame('a1', 'c1', 'wi-1')], 'wi-1', seen), false);
});

test('ignores frames for a different work item', () => {
  const seen = new Map<string, number | string>();
  assert.equal(hasNewAttachmentFrameFor([frame('a2', 'c2', 'wi-OTHER')], 'wi-1', seen), false);
});

test('fires again when the same attachment id gets a newer cursor', () => {
  const seen = new Map<string, number | string>();
  assert.equal(hasNewAttachmentFrameFor([frame('a1', 'c1', 'wi-1')], 'wi-1', seen), true);
  assert.equal(hasNewAttachmentFrameFor([frame('a1', 'c2', 'wi-1')], 'wi-1', seen), true);
});

test('skips frames with no entityId', () => {
  const seen = new Map<string, number | string>();
  const noId = { ...frame('x', 'c1', 'wi-1'), entityId: '' } as unknown as LiveEvent;
  assert.equal(hasNewAttachmentFrameFor([noId], 'wi-1', seen), false);
});
