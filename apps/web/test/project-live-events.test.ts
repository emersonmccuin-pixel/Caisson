import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  containsProjectChangedRefetchEvent,
  projectChangedLiveEventFromUnknown,
  projectWsTargetIds,
  projectWsTargetKeyFromIds,
  scanProjectChangedEvents,
  shouldAcceptProjectWsEnvelope,
} from '../src/features/projects/live-events.ts';
import {
  readStoredProjectChangedCursor,
  writeStoredProjectChangedCursor,
} from '../src/features/live/hooks.ts';

test('project websocket filter accepts only matching project events or project.changed globals', () => {
  assert.equal(
    shouldAcceptProjectWsEnvelope({ type: 'work-item-changed', projectId: 'p1' }, 'p1'),
    true,
  );
  assert.equal(
    shouldAcceptProjectWsEnvelope({ type: 'work-item-changed', projectId: 'p2' }, 'p1'),
    false,
  );
  assert.equal(
    shouldAcceptProjectWsEnvelope({ type: 'pod-changed' }, 'p1'),
    false,
  );
  assert.equal(
    shouldAcceptProjectWsEnvelope({
      type: 'project.changed',
      scope: 'global',
      projectId: null,
      reason: 'reordered',
    }, 'p1'),
    true,
  );
  assert.equal(
    shouldAcceptProjectWsEnvelope({
      type: 'project.changed',
      scope: 'project',
      projectId: null,
      reason: 'reordered',
    }, 'p1'),
    false,
  );
  assert.equal(
    shouldAcceptProjectWsEnvelope({
      type: 'live-event',
      event: projectChangedLiveEvent('evt1', '4'),
    }, 'p1'),
    true,
  );
  // Slice 015a — the relay delivers ALL entity families as `live-event` frames
  // (not only project.changed). A global frame (event.projectId === null) is
  // accepted regardless of entity so the WS cursor advances.
  assert.equal(
    shouldAcceptProjectWsEnvelope({
      type: 'live-event',
      event: { ...projectChangedLiveEvent('evt2', '5'), type: 'work-item.changed' },
    }, 'p1'),
    true,
  );
  // A project-scoped relay frame for a DIFFERENT project is still rejected.
  assert.equal(
    shouldAcceptProjectWsEnvelope({
      type: 'live-event',
      event: {
        ...projectChangedLiveEvent('evt3', '6'),
        scope: 'project',
        projectId: 'p2',
        type: 'work-item.changed',
      },
    }, 'p1'),
    false,
  );
  // A project-scoped relay frame for THIS project is accepted.
  assert.equal(
    shouldAcceptProjectWsEnvelope({
      type: 'live-event',
      event: {
        ...projectChangedLiveEvent('evt4', '7'),
        scope: 'project',
        projectId: 'p1',
        type: 'work-item.changed',
      },
    }, 'p1'),
    true,
  );
  // The server gap signal is always accepted so the client can self-heal.
  assert.equal(
    shouldAcceptProjectWsEnvelope({ type: 'live-reset', projectId: null, cursor: '9' }, 'p1'),
    true,
  );
});

test('project.changed event scanner only considers new events after a start index', () => {
  const events = [
    { type: 'project.changed', scope: 'global', projectId: null, reason: 'created' },
    { type: 'work-item-changed', projectId: 'p1' },
    { type: 'project.changed', scope: 'global', projectId: null, reason: 'soft-deleted' },
  ];

  assert.equal(containsProjectChangedRefetchEvent(events, 0), true);
  assert.equal(containsProjectChangedRefetchEvent(events, 1), true);
  assert.equal(containsProjectChangedRefetchEvent(events, 3), false);
});

test('project.changed scanner dedupes canonical live events and tracks latest cursor', () => {
  const seen = new Set<string>();
  const events = [
    { type: 'live-event', event: projectChangedLiveEvent('evt1', '7') },
    { type: 'live-event', event: projectChangedLiveEvent('evt1', '7') },
    { type: 'project.changed', scope: 'global', projectId: null, reason: 'soft-deleted' },
  ];

  assert.deepEqual(scanProjectChangedEvents(events, 0, seen), {
    shouldRefetch: true,
    latestCursor: '7',
  });
  assert.deepEqual(scanProjectChangedEvents(events, 0, seen), {
    shouldRefetch: true,
    latestCursor: '7',
  });
  assert.equal(projectChangedLiveEventFromUnknown(events[0])?.id, 'evt1');
});

test('all-project websocket target key is stable across metadata-only project refetches', () => {
  const before = [
    { id: 'p2', name: 'Two' },
    { id: 'p1', name: 'One' },
    { id: 'active', name: 'Active' },
  ];
  const after = [
    { id: 'active', name: 'Active renamed' },
    { id: 'p1', name: 'One renamed' },
    { id: 'p2', name: 'Two renamed' },
  ];

  const beforeKey = projectWsTargetKeyFromIds(projectWsTargetIds(before, 'active', true));
  const afterKey = projectWsTargetKeyFromIds(projectWsTargetIds(after, 'active', true));

  assert.equal(beforeKey, 'p1,p2');
  assert.equal(afterKey, beforeKey);
  assert.equal(projectWsTargetKeyFromIds(projectWsTargetIds(after, 'active', false)), '');
});

test('project live cursor storage is best-effort and keyed narrowly', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };

  assert.equal(readStoredProjectChangedCursor(storage), null);
  writeStoredProjectChangedCursor('12', storage);
  assert.equal(readStoredProjectChangedCursor(storage), '12');
  writeStoredProjectChangedCursor(null, storage);
  assert.equal(readStoredProjectChangedCursor(storage), '12');
});

function projectChangedLiveEvent(id: string, cursor: string) {
  return {
    id,
    cursor,
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: 'p1',
    version: null,
    createdAt: 1,
    payload: {
      reason: 'metadata-updated',
      projectIdChanged: 'p1',
    },
  };
}
