// pc-pty-chat-377 + pc-pty-chat-292 — cross-project READ + slug/name resolution.
//
// Covers the slug/name resolution logic that backs every targetProjectId param:
//  - resolveProject with a ULID resolves to the correct project.
//  - resolveProject with a slug resolves to the correct project.
//  - resolveProject with a display name (case-insensitive) resolves correctly.
//  - Routes using the resolved project return a work item that belongs to it.
//  - The project-scope guard: a ULID routed through the WRONG project returns 404.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { Project, ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-cross-project-read-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject,
  createWorkItem,
  getProjectById,
  getProjectBySlug,
  listProjects,
  runMigrations,
} = await import('@pc/db');
const { registerWorkItemRoutes } = await import('../src/features/work-items/routes.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Mirror of the enhanced resolveProject from index.ts: ULID → slug → name. */
function resolveProjectHandle(handle: string): Project | null {
  const byId = getProjectById(handle as ULID);
  if (byId) return byId;
  const bySlug = getProjectBySlug(handle);
  if (bySlug) return bySlug;
  const lower = handle.toLowerCase();
  return listProjects().find((p) => p.name.toLowerCase() === lower) ?? null;
}

/** Minimal route harness: resolveProject supports ULID | slug | name. */
function makeApp() {
  const app = new Hono();
  registerWorkItemRoutes(app, {
    resolveProject: (handle: string) => {
      const project = resolveProjectHandle(handle);
      if (!project) return null;
      const pid = project.id;
      return {
        project,
        workItemService: () => ({
          get: (wiId: ULID) => {
            const wi = createWorkItem; // just for type inference — unused below
            void wi;
            const { getWorkItem } = require('@pc/db') as { getWorkItem: (id: ULID) => { id: ULID; projectId: ULID } | undefined };
            const item = getWorkItem(wiId);
            return (item && item.projectId === pid ? item : null) as unknown as ReturnType<import('../src/services/work-item.ts').WorkItemService['get']>;
          },
          list: () => ({ items: [], nextCursor: undefined }),
        }),
        attachmentService: () => ({}),
        fieldSchemaService: () => ({ getAll: () => [] }),
        moveWorkItemV2: () => { throw new Error('not used'); },
      } as unknown as ReturnType<Parameters<typeof registerWorkItemRoutes>[1]['resolveProject']>;
    },
    broadcastTo: () => {},
    refreshProject: () => {},
  });
  return app;
}

const ts = Date.now();
const projectA = createProject({
  slug: `cpr-a-${ts}`,
  name: `Cross Read A ${ts}`,
  stages: [{ id: 'todo', name: 'Todo', order: 0 }],
  folderPath: '',
});
const projectB = createProject({
  slug: `cpr-b-${ts}`,
  name: `Cross Read B ${ts}`,
  stages: [{ id: 'todo', name: 'Todo', order: 0 }],
  folderPath: '',
});
const wiInB = createWorkItem({ projectId: projectB.id as ULID, title: 'Card in B', stageId: 'todo' });

test('cross-project read: ULID resolves to the correct project', () => {
  const resolved = resolveProjectHandle(projectB.id);
  assert.ok(resolved, 'should resolve by ULID');
  assert.equal(resolved.id, projectB.id);
});

test('cross-project read: slug resolves to the correct project', () => {
  const resolved = resolveProjectHandle(projectB.slug);
  assert.ok(resolved, 'should resolve by slug');
  assert.equal(resolved.id, projectB.id);
});

test('cross-project read: display name (case-insensitive) resolves to the correct project', () => {
  const resolved = resolveProjectHandle(projectB.name.toLowerCase());
  assert.ok(resolved, 'should resolve by lowercased name');
  assert.equal(resolved.id, projectB.id);
});

test('cross-project read: unknown handle returns null', () => {
  const resolved = resolveProjectHandle('this-does-not-exist-xyz');
  assert.equal(resolved, null);
});

test('cross-project read: GET /projects/:targetUlid/work-items/:wiId returns the card', async () => {
  const app = makeApp();
  const res = await app.request(`/api/projects/${projectB.id}/work-items/${wiInB.id}`);
  assert.equal(res.status, 200, 'should find card in its own project by ULID');
  const body = await res.json() as { ok: boolean; workItem: { id: string } };
  assert.equal(body.ok, true);
  assert.equal(body.workItem.id, wiInB.id);
});

test('cross-project read: GET /projects/:slug/work-items/:wiId returns the card', async () => {
  const app = makeApp();
  const res = await app.request(`/api/projects/${projectB.slug}/work-items/${wiInB.id}`);
  assert.equal(res.status, 200, 'should find card when project is addressed by slug');
  const body = await res.json() as { ok: boolean; workItem: { id: string } };
  assert.equal(body.ok, true);
  assert.equal(body.workItem.id, wiInB.id);
});

test('cross-project read: project-scope guard — ULID from project B routed through project A returns 404', async () => {
  const app = makeApp();
  const res = await app.request(`/api/projects/${projectA.id}/work-items/${wiInB.id}`);
  assert.equal(res.status, 404, 'project-scope guard must reject a mismatched ULID');
});
