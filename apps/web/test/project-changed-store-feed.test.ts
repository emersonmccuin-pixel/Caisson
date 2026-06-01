// T3.2 — the project-list refetch now rides the identity-keyed live store's
// global `project` signature instead of a positional WS-array scan.
//
// The hook's message handler (use-all-projects-ws / use-project-ws) feeds every
// live-event frame into useLiveStore and advances a per-project cursor; the App
// refetches when useLiveGlobalSignature('project') flips. The component can't be
// rendered here (no jsdom) so we pin the seams the hook + App wire to, matching
// the repo's other web tests:
//   1. a project.changed live-event lands in the store and flips the global
//      `project` signature (including a REORDER frame — entityId 'reorder', the
//      server fix; null-entityId frames are dropped, so this is load-bearing).
//   2. the per-project cursor advances monotonically.
//   3. a live-reset clears the store + cursor.
//   4. an unrelated entity's frame does NOT move the `project` signature.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LiveEvent, LiveEventEntity } from '@pc/contracts';

import { useLiveStore } from '../src/store/live-store.ts';
import {
  advanceLiveCursor,
  clearLiveCursor,
  liveCursorScopeForProject,
} from '../src/features/live/hooks.ts';

function projectFrame(
  over: Partial<LiveEvent>,
): { type: 'live-event'; event: LiveEvent } {
  return {
    type: 'live-event',
    event: {
      id: 'id-1',
      cursor: '1',
      scope: 'global',
      projectId: null,
      type: 'project.changed',
      entity: 'project',
      entityId: 'proj-1',
      version: null,
      createdAt: 1,
      payload: { reason: 'metadata-updated', projectIdChanged: 'proj-1' },
      ...over,
    } as LiveEvent,
  };
}

// Verbatim copy of useLiveGlobalSignature's selector body (what the App keys on).
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

function memStorage() {
  const values = new Map<string, string>();
  return {
    store: values,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
    removeItem: (k: string) => void values.delete(k),
  };
}

test('a project.changed frame lands in the store and flips the global project signature', () => {
  useLiveStore.getState().clearAll();
  const store = useLiveStore.getState();
  const before = globalSignature(useLiveStore.getState().byKey, 'project');
  store.applyEnvelope(projectFrame({ id: 'a', entityId: 'proj-1', cursor: '1' }));
  const after = globalSignature(useLiveStore.getState().byKey, 'project');
  assert.notEqual(before, after);
  // A newer frame (later cursor, null version = last-write-wins) advances again.
  store.applyEnvelope(projectFrame({ id: 'b', entityId: 'proj-1', cursor: '2' }));
  assert.notEqual(after, globalSignature(useLiveStore.getState().byKey, 'project'));
});

test('a REORDER frame (entityId "reorder") lands and flips the signature (server fix)', () => {
  useLiveStore.getState().clearAll();
  const store = useLiveStore.getState();
  const before = globalSignature(useLiveStore.getState().byKey, 'project');
  // Reorder carries no projectIdChanged; the server synthesizes entityId 'reorder'.
  // Were it null, the store would DROP it and a reorder would be invisible.
  store.applyEnvelope(
    projectFrame({ id: 'r1', entityId: 'reorder', cursor: '5', payload: { reason: 'reordered' } }),
  );
  const after = globalSignature(useLiveStore.getState().byKey, 'project');
  assert.notEqual(before, after);
  // A second reorder overwrites the same key and advances the cursor → flips again.
  store.applyEnvelope(
    projectFrame({ id: 'r2', entityId: 'reorder', cursor: '6', payload: { reason: 'reordered' } }),
  );
  assert.notEqual(after, globalSignature(useLiveStore.getState().byKey, 'project'));
});

test('a null-entityId frame is dropped (why the reorder synthetic id matters)', () => {
  useLiveStore.getState().clearAll();
  const store = useLiveStore.getState();
  store.applyEnvelope(projectFrame({ id: 'n', entityId: null, cursor: '9' }));
  assert.equal(globalSignature(useLiveStore.getState().byKey, 'project'), '');
});

test('an unrelated entity frame does NOT move the project signature', () => {
  useLiveStore.getState().clearAll();
  const store = useLiveStore.getState();
  store.applyEnvelope(projectFrame({ id: 'p', entityId: 'proj-1' }));
  const mine = globalSignature(useLiveStore.getState().byKey, 'project');
  store.applyEnvelope(
    projectFrame({
      id: 'w',
      entity: 'work-item' as LiveEventEntity,
      type: 'work-item.changed',
      scope: 'project',
      projectId: 'p1',
      entityId: 'wi-1',
    }),
  );
  assert.equal(globalSignature(useLiveStore.getState().byKey, 'project'), mine);
});

test('the per-project cursor advances monotonically on a live-event', () => {
  const s = memStorage();
  const scope = liveCursorScopeForProject('proj-bg');
  advanceLiveCursor(scope, '3', s);
  assert.equal(s.getItem(`pc.live.cursor.${scope}`), '3');
  advanceLiveCursor(scope, '7', s);
  assert.equal(s.getItem(`pc.live.cursor.${scope}`), '7');
  // Never moves backwards.
  advanceLiveCursor(scope, '4', s);
  assert.equal(s.getItem(`pc.live.cursor.${scope}`), '7');
});

test('a live-reset clears the store and drops the cursor', () => {
  const s = memStorage();
  const scope = liveCursorScopeForProject('proj-bg');
  advanceLiveCursor(scope, '5', s);
  useLiveStore.getState().clearAll();
  useLiveStore.getState().applyEnvelope(projectFrame({ id: 'q', entityId: 'proj-1' }));
  assert.notEqual(globalSignature(useLiveStore.getState().byKey, 'project'), '');
  // live-reset branch: clear cursor + store.
  clearLiveCursor(scope, s);
  useLiveStore.getState().clearAll();
  assert.equal(s.getItem(`pc.live.cursor.${scope}`), null);
  assert.equal(globalSignature(useLiveStore.getState().byKey, 'project'), '');
});
