import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveEventFrame,
  isLiveEvent,
  isLiveEventFrame,
  isProjectChangedLiveEvent,
  isProjectChangedLiveEventFrame,
  parseListLiveEventsQuery,
  toProjectChangedRefetchEnvelope,
  type ProjectChangedLiveEvent,
} from '../src/index.ts';

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
  assert.equal(isLiveEvent({ ...event, entity: 'workflow-run' }), false);
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
  assert.deepEqual(parseListLiveEventsQuery({ type: 'bogus.type' }), {
    ok: false,
    error: 'unsupported live event type',
    code: 'VALIDATION',
  });
});
