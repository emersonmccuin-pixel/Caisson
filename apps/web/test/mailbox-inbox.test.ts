// T3.1 — the mailbox inbox now refetches off the live store's per-entity
// signatures, not a positional scan of the chat events[]. This pins the two
// load-bearing seams the rewire depends on, driven against the REAL store:
//   1. applyEnvelope keys the message fact and the delivery frame on DISTINCT
//      store slots (writer fix) so they don't mis-dedup against each other.
//   2. the signature for `mailbox-message` / `pending-interaction` flips once
//      per genuine in-scope change and never on an unrelated entity — for both
//      project scope and the project-less (global) inbox.
//
// The signature selector body is replicated verbatim (it lives inside a React
// hook in live-store.ts and can't be called outside a render); production wires
// the inbox refetch effect directly to those hooks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LiveEvent, LiveEventEntity } from '@pc/contracts';

import { useLiveStore } from '../src/store/live-store.ts';

function frame(over: Partial<LiveEvent>): { type: 'live-event'; event: LiveEvent } {
  return {
    type: 'live-event',
    event: {
      id: 'id-1',
      cursor: '1',
      scope: 'project',
      projectId: 'p1',
      type: 'mailbox.message.changed',
      entity: 'mailbox-message',
      entityId: 'm1',
      version: null,
      createdAt: 1,
      payload: {},
      ...over,
    } as LiveEvent,
  };
}

// Verbatim copy of useLiveEntitySignature's selector body (project scope).
function entitySignature(byKey: Map<string, LiveEvent>, entity: LiveEventEntity | null, projectId: string | null): string {
  if (!entity || !projectId) return '';
  let sig = '';
  for (const ev of byKey.values()) {
    if (ev.entity !== entity) continue;
    if (ev.projectId !== null && ev.projectId !== projectId) continue;
    sig += `${ev.entityId}:${ev.version ?? ev.cursor};`;
  }
  return sig;
}

// Verbatim copy of useLiveGlobalSignature's selector body.
function globalSignature(byKey: Map<string, LiveEvent>, entity: LiveEventEntity | null): string {
  if (!entity) return '';
  let sig = '';
  for (const ev of byKey.values()) {
    if (ev.entity !== entity) continue;
    if (ev.projectId !== null) continue;
    sig += `${ev.entityId}:${ev.version ?? ev.cursor};`;
  }
  return sig;
}

function reset() {
  useLiveStore.getState().clearAll();
}

test('message fact and delivery frame for the same message occupy DISTINCT store slots', () => {
  reset();
  const store = useLiveStore.getState();
  store.applyEnvelope(frame({ id: 'a', entityId: 'm1', version: null, type: 'mailbox.message.changed' }));
  store.applyEnvelope(frame({ id: 'b', entityId: 'd1', version: 0, type: 'mailbox.delivery.changed' }));
  const byKey = useLiveStore.getState().byKey;
  assert.ok(byKey.has('mailbox-message::m1'));
  assert.ok(byKey.has('mailbox-message::d1'));
  // Both are present — neither overwrote the other.
  assert.equal(byKey.size, 2);
});

test('project signature flips once per genuine change, not on an unrelated entity', () => {
  reset();
  const store = useLiveStore.getState();
  store.applyEnvelope(frame({ id: 'a', entityId: 'm1', version: null }));
  const s1 = entitySignature(useLiveStore.getState().byKey, 'mailbox-message', 'p1');

  // Same message id, null version (last-write-wins) → new cursor advances sig.
  store.applyEnvelope(frame({ id: 'a2', entityId: 'm1', version: null, cursor: '2' }));
  const s2 = entitySignature(useLiveStore.getState().byKey, 'mailbox-message', 'p1');
  assert.notEqual(s1, s2);

  // A pending-interaction frame must NOT change the mailbox-message signature.
  store.applyEnvelope(frame({ id: 'pi', entity: 'pending-interaction', entityId: 'i1', version: 1, type: 'pending-interaction.changed' }));
  const s3 = entitySignature(useLiveStore.getState().byKey, 'mailbox-message', 'p1');
  assert.equal(s2, s3);
  // …but it DOES change the pending-interaction signature.
  assert.notEqual(entitySignature(useLiveStore.getState().byKey, 'pending-interaction', 'p1'), '');
});

test('a frame for another project does not move this project signature', () => {
  reset();
  const store = useLiveStore.getState();
  store.applyEnvelope(frame({ id: 'a', entityId: 'm1' }));
  const mine = entitySignature(useLiveStore.getState().byKey, 'mailbox-message', 'p1');
  store.applyEnvelope(frame({ id: 'other', entityId: 'm2', projectId: 'p2' }));
  assert.equal(entitySignature(useLiveStore.getState().byKey, 'mailbox-message', 'p1'), mine);
});

test('global inbox signature keys on project-less message frames only', () => {
  reset();
  const store = useLiveStore.getState();
  // A project-scoped frame must NOT show in the global signature.
  store.applyEnvelope(frame({ id: 'p', entityId: 'm1', projectId: 'p1' }));
  assert.equal(globalSignature(useLiveStore.getState().byKey, 'mailbox-message'), '');
  // A global (scope:global / projectId:null) message frame does.
  store.applyEnvelope(frame({ id: 'g', entityId: 'gm1', projectId: null, scope: 'global', cursor: '9' }));
  assert.equal(globalSignature(useLiveStore.getState().byKey, 'mailbox-message'), 'gm1:9;');
});
