// T3.2 — reorder `project.changed` frames must carry a stable, NON-NULL
// entityId ('reorder') so the client's identity-keyed live store keeps them
// (it drops null-entityId frames) and the global `project` signature advances on
// a reorder. created/updated/deleted keep entityId === projectIdChanged. The
// draft (DB path) and the ephemeral (no-tx path, via ProjectService with an
// injected repo) must agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProjectDto } from '@pc/contracts';

import {
  buildProjectChangedLiveEventDraft,
  projectChangedPayload,
  ProjectService,
  type ProjectRepositoryPort,
} from '../src/projects.ts';

const PROJECT: ProjectDto = {
  id: 'proj-123',
  slug: 'proj',
  name: 'Proj',
  stages: [],
  folderPath: '/tmp/proj',
  gitRemote: null,
  settings: { cancelledVisibility: 'use-global' },
  callsignSeq: 0,
};

test('reorder draft gets the synthetic entityId "reorder" (never null)', () => {
  const draft = buildProjectChangedLiveEventDraft(projectChangedPayload('reordered'));
  assert.equal(draft.entityId, 'reorder');
  assert.equal(draft.entity, 'project');
  assert.equal(draft.scope, 'global');
  assert.equal(draft.projectId, null);
  assert.equal(draft.version, null);
});

test('created/updated/deleted drafts keep entityId === projectIdChanged', () => {
  for (const reason of ['created', 'metadata-updated', 'soft-deleted'] as const) {
    const draft = buildProjectChangedLiveEventDraft(projectChangedPayload(reason, PROJECT));
    assert.equal(draft.entityId, 'proj-123', `reason ${reason}`);
  }
});

test('ephemeral reorder event agrees with the draft (entityId "reorder")', () => {
  const repo = stubRepo();
  const svc = new ProjectService(repo);
  const result = svc.reorderProjects({ orderedIds: ['proj-123'] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.liveEvent.entityId, 'reorder');
  assert.equal(result.liveEvent.entity, 'project');
  assert.equal(result.liveEvent.scope, 'global');
  assert.equal(result.liveEvent.projectId, null);
  // Matches the draft for the same reason.
  const draft = buildProjectChangedLiveEventDraft(projectChangedPayload('reordered'));
  assert.equal(result.liveEvent.entityId, draft.entityId);
});

test('ephemeral metadata-updated event keeps entityId === project id', () => {
  const repo = stubRepo();
  const svc = new ProjectService(repo);
  const result = svc.updateProjectMeta('proj-123', { name: 'Renamed' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.liveEvent.entityId, 'proj-123');
});

function stubRepo(): ProjectRepositoryPort {
  return {
    listProjects: () => [],
    getProjectById: () => null,
    updateProjectMeta: () => ({
      id: 'proj-123',
      slug: 'proj',
      name: 'Renamed',
      stages: [],
      folderPath: '/tmp/proj',
      gitRemote: null,
      settings: { cancelledVisibility: 'use-global' },
      callsignSeq: 0,
    }),
    reorderProjects: () => {},
    softDeleteProject: () => null,
  };
}
