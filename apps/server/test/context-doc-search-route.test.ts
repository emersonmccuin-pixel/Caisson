// Regression test: GET .../context-docs/search must NOT be shadowed by /:docId.
//
// Before the fix, Hono matched the literal segment "search" as a :docId param
// and returned 404 "unknown context doc: search". This test asserts the search
// route is reachable and returns results.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-cdoc-search-route-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createContextDoc, createProject, runMigrations } = await import('@pc/db');
const { registerContextDocRoutes } = await import('../src/features/context-docs/routes.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('search route returns results, not 404 (route-shadowing regression)', async () => {
  const project = createProject({
    slug: `search-fix-${Date.now()}`,
    name: 'Search Fix Test',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: '',
  });
  const projectId = project.id as ULID;

  // Seed a doc with a distinctive term.
  createContextDoc({
    scope: { projectId },
    title: 'ContextSearchRouteTerm guide',
    body: 'This document contains ContextSearchRouteTerm for FTS matching.',
    author: 'test',
  });

  const app = new Hono();
  registerContextDocRoutes(app, {
    resolveProject: (id) => (id === projectId ? { project: { id: projectId } } : null),
  });

  const res = await app.request(
    `/api/projects/${projectId}/context-docs/search?q=ContextSearchRouteTerm`,
  );

  // Must not be 404 (the old shadow-match behaviour).
  assert.notEqual(res.status, 404, 'search route must not be shadowed by /:docId');
  assert.equal(res.status, 200);

  const body = (await res.json()) as { ok: boolean; results: { id: string }[] };
  assert.equal(body.ok, true);
  assert.ok(body.results.length >= 1, 'expected at least one search hit');
});

test('/:docId route still works after search is moved above it', async () => {
  const project = createProject({
    slug: `docid-fix-${Date.now()}`,
    name: 'DocId Fix Test',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: '',
  });
  const projectId = project.id as ULID;

  const doc = createContextDoc({
    scope: { projectId },
    title: 'Reachable Doc',
    body: 'body text',
    author: 'test',
  });

  const app = new Hono();
  registerContextDocRoutes(app, {
    resolveProject: (id) => (id === projectId ? { project: { id: projectId } } : null),
  });

  const res = await app.request(`/api/projects/${projectId}/context-docs/${doc.id}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; doc: { id: string } };
  assert.equal(body.ok, true);
  assert.equal(body.doc.id, doc.id);
});
