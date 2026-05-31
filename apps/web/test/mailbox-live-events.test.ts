import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMailboxLiveFrame,
  scanMailboxLiveEvents,
  shouldAcceptMailboxWsEnvelope,
} from '../src/features/mailbox/live-events.ts';

function messageFrame(id: string, cursor: string, scope: 'project' | 'global' = 'project', projectId: string | null = 'p1') {
  return {
    type: 'live-event',
    event: {
      id,
      cursor,
      scope,
      projectId,
      type: 'mailbox.message.changed',
      entity: 'mailbox-message',
      entityId: 'm1',
      version: null,
      createdAt: 1,
      payload: { messageId: 'm1', kind: 'system-notice', recipientSummary: { total: 1, unread: 1, actionable: 0 } },
    },
  };
}

function deliveryFrame(id: string, cursor: string) {
  return {
    type: 'live-event',
    event: {
      id,
      cursor,
      scope: 'project',
      projectId: 'p1',
      type: 'mailbox.delivery.changed',
      entity: 'mailbox-message',
      entityId: 'm1',
      version: 1,
      createdAt: 1,
      payload: { deliveryId: 'd1', messageId: 'm1', status: 'accepted', attempts: 1, targetRef: { kind: 'send-queue', id: 'sq1' }, lastError: null },
    },
  };
}

function interactionFrame(id: string, cursor: string) {
  return {
    type: 'live-event',
    event: {
      id,
      cursor,
      scope: 'project',
      projectId: 'p1',
      type: 'pending-interaction.changed',
      entity: 'pending-interaction',
      entityId: 'i1',
      version: 2,
      createdAt: 1,
      payload: { interactionId: 'i1', kind: 'runtime-hook-ask', status: 'answered', version: 2 },
    },
  };
}

test('accepts mailbox/delivery/interaction frames; rejects unrelated frames', () => {
  assert.equal(isMailboxLiveFrame(messageFrame('e1', '1')), true);
  assert.equal(isMailboxLiveFrame(deliveryFrame('e2', '2')), true);
  assert.equal(isMailboxLiveFrame(interactionFrame('e3', '3')), true);
  assert.equal(isMailboxLiveFrame({ type: 'live-event', event: { type: 'agent.run.changed' } }), false);
  assert.equal(shouldAcceptMailboxWsEnvelope(messageFrame('e1', '1', 'global', null), 'p1'), true);
  assert.equal(shouldAcceptMailboxWsEnvelope({ projectId: 'p1' }, 'p1'), true);
  assert.equal(shouldAcceptMailboxWsEnvelope({ projectId: 'other' }, 'p1'), false);
});

test('scan signals a refetch on new frames and tracks the latest cursor', () => {
  const events = [messageFrame('e1', '1'), deliveryFrame('e2', '2'), interactionFrame('e3', '3')];
  const res = scanMailboxLiveEvents(events, 0);
  assert.equal(res.changed, true);
  assert.equal(res.latestCursor, '3');
});

test('dedupes by event id (a duplicate id does not re-signal)', () => {
  const seen = new Set<string>();
  const first = scanMailboxLiveEvents([messageFrame('e1', '1')], 0, seen);
  assert.equal(first.changed, true);
  // Re-scan the same frame from index 0 with the same seen-set: no NEW id.
  const second = scanMailboxLiveEvents([messageFrame('e1', '1')], 0, seen, { changed: false, latestCursor: first.latestCursor });
  assert.equal(second.changed, false);
});

test('a global user-inbox message frame is accepted (scope:global / projectId:null)', () => {
  const res = scanMailboxLiveEvents([messageFrame('g1', '9', 'global', null)], 0);
  assert.equal(res.changed, true);
  assert.equal(res.latestCursor, '9');
});

test('ignores non-mailbox frames in the stream', () => {
  const events = [{ type: 'live-event', event: { id: 'x', cursor: '1', type: 'project.changed', entity: 'project' } }];
  const res = scanMailboxLiveEvents(events, 0);
  assert.equal(res.changed, false);
});
