// T3.1 — the sessions rail's two refetch triggers, pinned as contract seams.
// (The component can't be rendered in this harness — no jsdom/testing-library —
// so we pin the logic the rail wires to, matching the repo's other web tests.)
//
//   1. session.title.changed (relay FACT): the `session-title` signature from
//      the live store flips when a title frame lands in the rail's project
//      scope, and is inert for another project's title frame.
//   2. session-changed (chat LIFECYCLE envelope, not a relay fact): consumed
//      from the reducer's monotonic `sessionChangedNonce` — covered by
//      chat-session-nonce.test.ts (ticks on new AND resume, even same id).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LiveEvent, LiveEventEntity } from '@pc/contracts';

import { useLiveStore } from '../src/store/live-store.ts';

function titleFrame(over: Partial<LiveEvent>): { type: 'live-event'; event: LiveEvent } {
  return {
    type: 'live-event',
    event: {
      id: 'id-1',
      cursor: '1',
      scope: 'project',
      projectId: 'p1',
      type: 'session.title.changed',
      entity: 'session-title',
      entityId: 'sess-1',
      version: null,
      createdAt: 1,
      payload: {},
      ...over,
    } as LiveEvent,
  };
}

// Verbatim copy of useLiveEntitySignature's selector body (what the rail keys on).
function titleSignature(byKey: Map<string, LiveEvent>, entity: LiveEventEntity | null, projectId: string | null): string {
  if (!entity || !projectId) return '';
  let sig = '';
  for (const ev of byKey.values()) {
    if (ev.entity !== entity) continue;
    if (ev.projectId !== null && ev.projectId !== projectId) continue;
    sig += `${ev.entityId}:${ev.version ?? ev.cursor};`;
  }
  return sig;
}

test('the session-title signature flips when a title frame lands in scope', () => {
  useLiveStore.getState().clearAll();
  const store = useLiveStore.getState();
  const before = titleSignature(useLiveStore.getState().byKey, 'session-title', 'p1');
  store.applyEnvelope(titleFrame({ id: 'a', entityId: 'sess-1', cursor: '1' }));
  const after = titleSignature(useLiveStore.getState().byKey, 'session-title', 'p1');
  assert.notEqual(before, after);
  // A newer title frame for the same session advances it again.
  store.applyEnvelope(titleFrame({ id: 'b', entityId: 'sess-1', cursor: '2' }));
  assert.notEqual(after, titleSignature(useLiveStore.getState().byKey, 'session-title', 'p1'));
});

test('a title frame for another project does NOT move this project signature', () => {
  useLiveStore.getState().clearAll();
  const store = useLiveStore.getState();
  store.applyEnvelope(titleFrame({ id: 'a', entityId: 'sess-1', projectId: 'p1' }));
  const mine = titleSignature(useLiveStore.getState().byKey, 'session-title', 'p1');
  store.applyEnvelope(titleFrame({ id: 'x', entityId: 'sess-9', projectId: 'p2' }));
  assert.equal(titleSignature(useLiveStore.getState().byKey, 'session-title', 'p1'), mine);
});
