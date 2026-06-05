import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProjectChangedRefetchEnvelope,
  isProjectChangedLivePayload,
  isProjectChangedRefetchEnvelope,
  isProjectDto,
  parseCreateProjectRequest,
  parseReorderProjectsRequest,
  parseUpdateProjectRequest,
  projectRoutes,
} from '../src/projects.ts';

test('project route constants preserve current HTTP paths', () => {
  assert.equal(projectRoutes.list, '/api/projects');
  assert.equal(projectRoutes.create, '/api/projects');
  assert.equal(projectRoutes.reorder, '/api/projects/reorder');
  assert.equal(projectRoutes.detail('project 1'), '/api/projects/project%201');
});

test('create project parser accepts current wire shape and trims command fields', () => {
  const parsed = parseCreateProjectRequest({
    name: '  Demo Project  ',
    folder_path: '  C:/work/demo  ',
    mode: 'attach-to-git',
    git_remote: null,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, {
    name: 'Demo Project',
    folder_path: 'C:/work/demo',
    mode: 'attach-to-git',
    git_remote: null,
  });
});

test('create project parser rejects missing required fields and invalid modes', () => {
  assert.deepEqual(parseCreateProjectRequest({ name: '', folder_path: 'x', mode: 'init-empty' }), {
    ok: false,
    error: 'name, folder_path, and mode required',
    code: 'VALIDATION',
  });
  assert.deepEqual(parseCreateProjectRequest({ name: 'x', folder_path: 'x', mode: 'clone' }), {
    ok: false,
    error: 'name, folder_path, and mode required',
    code: 'VALIDATION',
  });
});

test('update project parser keeps compatibility normalization', () => {
  const parsed = parseUpdateProjectRequest({
    name: '  Renamed  ',
    git_remote: '   ',
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, { name: 'Renamed', git_remote: null });
  assert.deepEqual(parseUpdateProjectRequest({ name: '   ' }), {
    ok: false,
    error: 'name cannot be empty',
    code: 'VALIDATION',
  });
});

test('reorder parser requires orderedIds as strings', () => {
  assert.deepEqual(parseReorderProjectsRequest({ orderedIds: ['a', 'b'] }), {
    ok: true,
    value: { orderedIds: ['a', 'b'] },
  });
  assert.deepEqual(parseReorderProjectsRequest({ orderedIds: ['a', 1] }), {
    ok: false,
    error: 'orderedIds must be an array of strings',
    code: 'VALIDATION',
  });
});

test('project dto guard requires the shared callsignSeq field', () => {
  const dto = {
    id: 'p1',
    slug: 'demo',
    name: 'Demo',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: 'C:/work/demo',
    gitRemote: null,
    settings: { cancelledVisibility: 'use-global', remoteControl: 'use-global' },
    callsignSeq: 0,
  };

  assert.equal(isProjectDto(dto), true);
  assert.equal(isProjectDto({ ...dto, callsignSeq: undefined }), false);
});

test('project.changed compatibility envelope is a global non-durable refetch hint', () => {
  const envelope = buildProjectChangedRefetchEnvelope({
    reason: 'metadata-updated',
    projectIdChanged: 'p1',
  });

  assert.deepEqual(envelope, {
    type: 'project.changed',
    scope: 'global',
    projectId: null,
    reason: 'metadata-updated',
    projectIdChanged: 'p1',
  });
  assert.equal(isProjectChangedRefetchEnvelope(envelope), true);
  assert.equal(isProjectChangedRefetchEnvelope({ type: 'project.changed', projectId: 'p1' }), false);
  assert.equal(isProjectChangedRefetchEnvelope({ type: 'pod-changed', scope: 'global' }), false);
  assert.equal(isProjectChangedLivePayload({ reason: 'metadata-updated' }), true);
  assert.equal(isProjectChangedLivePayload({ reason: 'metadata-updated', project: {} }), false);
});
