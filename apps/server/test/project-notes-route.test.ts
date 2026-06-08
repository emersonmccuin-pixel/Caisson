// pc-pty-chat-333: server-side test for the notes save/load route.
//
// Contracts verified:
//   1. PATCH /api/projects/:id/notes saves text and returns { ok, notes }.
//   2. GET /api/projects/:id returns the saved notes on subsequent reads.
//   3. Invalid body (missing text field) returns 400.
//   4. Unknown project returns 404.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-notes-route-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createProject, getProjectById, runMigrations } = await import('@pc/db');
const {
  registerProjectRoutes,
  registerProjectDetailRoute,
} = await import('../src/features/projects/routes.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp() {
  const app = new Hono();
  registerProjectRoutes(app, {
    createProject: async () => { throw new Error('not used'); },
    refreshProject: () => {},
    removeProject: () => {},
    resolveProject: (id) => {
      const p = getProjectById(id as ULID);
      return p ? { project: { id: p.id } } : null;
    },
    publishProjectChanged: () => {},
  });
  registerProjectDetailRoute(app, {
    resolveProject: (id) => {
      const p = getProjectById(id as ULID);
      return p ? { project: { id: p.id } } : null;
    },
  });
  return app;
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

test('notes save: PATCH stores text and returns ok + notes', async () => {
  const project = createProject({
    slug: `notes-save-${Date.now()}`,
    name: 'Notes Save Test',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: '',
  });
  const app = makeApp();

  const res = await app.request(`/api/projects/${project.id}/notes`, {
    method: 'PATCH',
    body: JSON.stringify({ text: 'my scratch notes' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const body = await json<{ ok: boolean; notes: string }>(res);
  assert.equal(body.ok, true);
  assert.equal(body.notes, 'my scratch notes');
});

test('notes load: GET project returns saved notes', async () => {
  const project = createProject({
    slug: `notes-load-${Date.now()}`,
    name: 'Notes Load Test',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: '',
  });
  const app = makeApp();

  // Save notes.
  await app.request(`/api/projects/${project.id}/notes`, {
    method: 'PATCH',
    body: JSON.stringify({ text: 'persistent notes text' }),
    headers: { 'content-type': 'application/json' },
  });

  // Reload via GET.
  const res = await app.request(`/api/projects/${project.id}`);
  assert.equal(res.status, 200);
  const body = await json<{ notes: string | null }>(res);
  assert.equal(body.notes, 'persistent notes text');
});

test('notes save: empty string clears notes', async () => {
  const project = createProject({
    slug: `notes-clear-${Date.now()}`,
    name: 'Notes Clear Test',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: '',
  });
  const app = makeApp();

  // Set notes first.
  await app.request(`/api/projects/${project.id}/notes`, {
    method: 'PATCH',
    body: JSON.stringify({ text: 'to be cleared' }),
    headers: { 'content-type': 'application/json' },
  });

  // Clear.
  const res = await app.request(`/api/projects/${project.id}/notes`, {
    method: 'PATCH',
    body: JSON.stringify({ text: '' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const body = await json<{ ok: boolean; notes: string }>(res);
  assert.equal(body.ok, true);
  assert.equal(body.notes, '');
});

test('notes save: missing text field returns 400', async () => {
  const project = createProject({
    slug: `notes-invalid-${Date.now()}`,
    name: 'Notes Invalid Test',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: '',
  });
  const app = makeApp();

  const res = await app.request(`/api/projects/${project.id}/notes`, {
    method: 'PATCH',
    body: JSON.stringify({ notText: 'wrong key' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 400);
  const body = await json<{ ok: boolean; error: string }>(res);
  assert.equal(body.ok, false);
});

test('notes save: unknown project returns 404', async () => {
  const app = makeApp();
  const res = await app.request('/api/projects/01NONEXISTENT0000000000000/notes', {
    method: 'PATCH',
    body: JSON.stringify({ text: 'hello' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 404);
  const body = await json<{ ok: boolean; error: string }>(res);
  assert.equal(body.ok, false);
});
