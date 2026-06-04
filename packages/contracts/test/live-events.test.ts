import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveEventFrame,
  isLiveEvent,
  isLiveEventFrame,
  isLiveEventResetFrame,
  isLiveEventSubscribe,
  isPodChangedLiveEvent,
  isPodChangedLiveEventFrame,
  isProjectChangedLiveEvent,
  isProjectChangedLiveEventFrame,
  parseListLiveEventsQuery,
  toProjectChangedRefetchEnvelope,
  type ProjectChangedLiveEvent,
} from '../src/index.ts';

// ── Slice 015a — subscribe handshake + reset guards ────────────────────────

test('isLiveEventSubscribe accepts valid handshakes and rejects bad cursors', () => {
  assert.equal(isLiveEventSubscribe({ type: 'subscribe' }), true);
  assert.equal(isLiveEventSubscribe({ type: 'subscribe', lastVersion: '42' }), true);
  assert.equal(
    isLiveEventSubscribe({ type: 'subscribe', lastVersion: '7', projectId: 'p1' }),
    true,
  );
  assert.equal(isLiveEventSubscribe({ type: 'subscribe', lastVersion: 'abc' }), false);
  assert.equal(isLiveEventSubscribe({ type: 'subscribe', lastVersion: '-1' }), false);
  assert.equal(isLiveEventSubscribe({ type: 'subscribe', projectId: '' }), false);
  assert.equal(isLiveEventSubscribe({ type: 'other' }), false);
});

test('isLiveEventResetFrame accepts global and project reset frames', () => {
  assert.equal(isLiveEventResetFrame({ type: 'live-reset', projectId: null, cursor: '9' }), true);
  assert.equal(isLiveEventResetFrame({ type: 'live-reset', projectId: 'p1', cursor: null }), true);
  assert.equal(isLiveEventResetFrame({ type: 'live-reset', projectId: null, cursor: 'x' }), false);
  assert.equal(isLiveEventResetFrame({ type: 'live-event' }), false);
});

const projectDto = {
  id: 'p1',
  slug: 'demo',
  name: 'Demo',
  stages: [{ id: 'todo', name: 'Todo', order: 0 }],
  folderPath: 'C:/work/demo',
  gitRemote: null,
  settings: { cancelledVisibility: 'use-global' as const },
  callsignSeq: 0,
};

function projectChangedEvent(overrides: Partial<ProjectChangedLiveEvent> = {}): ProjectChangedLiveEvent {
  return {
    id: 'evt1',
    cursor: '1',
    scope: 'global',
    projectId: null,
    type: 'project.changed',
    entity: 'project',
    entityId: 'p1',
    version: null,
    createdAt: 123,
    payload: {
      reason: 'metadata-updated',
      projectIdChanged: 'p1',
      project: projectDto,
    },
    ...overrides,
  };
}

test('live event guard enforces cursor and scope/project invariants', () => {
  const event = projectChangedEvent();

  assert.equal(isLiveEvent(event), true);
  assert.equal(isLiveEvent({ ...event, cursor: '01' }), false);
  assert.equal(isLiveEvent({ ...event, scope: 'global', projectId: 'p1' }), false);
  assert.equal(isLiveEvent({ ...event, scope: 'project', projectId: null }), false);
  assert.equal(isLiveEvent({ ...event, entity: 'not-an-entity' }), false);
  // slice 004 — workflow entities are now valid live-event entities.
  assert.equal(isLiveEvent({ ...event, scope: 'project', projectId: 'p1', entity: 'workflow-run' }), true);
});

test('project.changed live-event guard and frame guard stay narrow', () => {
  const event = projectChangedEvent();
  const frame = buildLiveEventFrame(event);

  assert.equal(isProjectChangedLiveEvent(event), true);
  assert.equal(isLiveEventFrame(frame), true);
  assert.equal(isProjectChangedLiveEventFrame(frame), true);
  assert.equal(isProjectChangedLiveEvent({ ...event, scope: 'project', projectId: 'p1' }), false);
  assert.equal(isProjectChangedLiveEvent({ ...event, type: 'pod-changed' }), false);
  assert.equal(
    isProjectChangedLiveEventFrame(buildLiveEventFrame({ ...event, entityId: null })),
    true,
  );
});

test('project.changed live event adapts to the legacy refetch envelope', () => {
  assert.deepEqual(toProjectChangedRefetchEnvelope(projectChangedEvent()), {
    type: 'project.changed',
    scope: 'global',
    projectId: null,
    reason: 'metadata-updated',
    projectIdChanged: 'p1',
    project: projectDto,
  });
});

test('pod.changed guards accept global + project frames and stay narrow', () => {
  const globalEvent = {
    id: 'evt-pod-1',
    cursor: '5',
    scope: 'global' as const,
    projectId: null,
    type: 'pod.changed' as const,
    entity: 'pod' as const,
    entityId: 'pod-1',
    version: null,
    createdAt: 1,
    payload: { change: 'created' as const, podId: 'pod-1', name: 'helper' },
  };
  assert.equal(isPodChangedLiveEvent(globalEvent), true);
  assert.equal(isPodChangedLiveEventFrame(buildLiveEventFrame(globalEvent)), true);

  const projectEvent = {
    ...globalEvent,
    id: 'evt-pod-2',
    scope: 'project' as const,
    projectId: 'p1',
    payload: { change: 'deleted' as const, podId: 'pod-2' },
  };
  assert.equal(isPodChangedLiveEvent(projectEvent), true);

  // Wrong type / entity / payload are rejected.
  assert.equal(isPodChangedLiveEvent({ ...globalEvent, type: 'project.changed' }), false);
  assert.equal(isPodChangedLiveEvent({ ...globalEvent, entity: 'project' }), false);
  assert.equal(
    isPodChangedLiveEvent({ ...globalEvent, payload: { change: 'bogus', podId: 'x' } }),
    false,
  );
  assert.equal(
    isPodChangedLiveEvent({ ...globalEvent, payload: { change: 'created' } }),
    false,
  );
  assert.equal(isPodChangedLiveEventFrame({ type: 'live-event' }), false);
});

test('live replay query parser validates cursors, type, and clamps limit', () => {
  assert.deepEqual(parseListLiveEventsQuery({ after: '2', includeGlobal: '1', limit: '999' }), {
    ok: true,
    value: { after: '2', includeGlobal: true, limit: 500 },
  });
  assert.deepEqual(parseListLiveEventsQuery({ limit: '-3' }), {
    ok: true,
    value: { includeGlobal: false, limit: 1 },
  });
  assert.deepEqual(parseListLiveEventsQuery({ after: 'abc' }), {
    ok: false,
    error: 'after must be a non-negative integer cursor',
    code: 'VALIDATION',
  });
  assert.deepEqual(parseListLiveEventsQuery({ type: 'work-item.changed' }), {
    ok: true,
    value: { includeGlobal: false, limit: 100, type: 'work-item.changed' },
  });
  assert.deepEqual(parseListLiveEventsQuery({ type: 'stage.list.changed' }), {
    ok: true,
    value: { includeGlobal: false, limit: 100, type: 'stage.list.changed' },
  });
  assert.deepEqual(parseListLiveEventsQuery({ type: 'workflow.run.changed' }), {
    ok: true,
    value: { includeGlobal: false, limit: 100, type: 'workflow.run.changed' },
  });
  assert.deepEqual(parseListLiveEventsQuery({ type: 'workflow.definition.changed' }), {
    ok: true,
    value: { includeGlobal: false, limit: 100, type: 'workflow.definition.changed' },
  });
  assert.deepEqual(parseListLiveEventsQuery({ type: 'agent.run.changed' }), {
    ok: true,
    value: { includeGlobal: false, limit: 100, type: 'agent.run.changed' },
  });
  // slice 007 — mailbox type names accepted by replay. (☠ M8/FD-7:
  // pending-interaction.changed — gone with the shadow table; asserted
  // rejected below.)
  assert.deepEqual(parseListLiveEventsQuery({ type: 'mailbox.message.changed' }), {
    ok: true,
    value: { includeGlobal: false, limit: 100, type: 'mailbox.message.changed' },
  });
  assert.deepEqual(parseListLiveEventsQuery({ type: 'mailbox.delivery.changed' }), {
    ok: true,
    value: { includeGlobal: false, limit: 100, type: 'mailbox.delivery.changed' },
  });
  assert.deepEqual(parseListLiveEventsQuery({ type: 'pending-interaction.changed' }), {
    ok: false,
    error: 'unsupported live event type',
    code: 'VALIDATION',
  });
  assert.deepEqual(parseListLiveEventsQuery({ type: 'pod.changed' }), {
    ok: true,
    value: { includeGlobal: false, limit: 100, type: 'pod.changed' },
  });
  assert.deepEqual(parseListLiveEventsQuery({ type: 'bogus.type' }), {
    ok: false,
    error: 'unsupported live event type',
    code: 'VALIDATION',
  });
});
