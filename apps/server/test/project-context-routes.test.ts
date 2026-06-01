// Slice 015b — project CLAUDE.md write announces through the relay door.
//
// PUT /api/projects/:id/claude-md writes the file AND a durable
// project.claude-md.changed live_outbox row in-txn; the relay delivers the
// canonical frame. No hand-fanout.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-project-context-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createProject, runMigrations, listLiveOutboxRowsAfter, getLiveEventHighWater } =
  await import('@pc/db');
const { registerProjectContextRoutes } = await import('../src/features/project-context/routes.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('claude-md write announces a project.claude-md.changed outbox row', async () => {
  const folderPath = join(tmpDir, `proj-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(folderPath, { recursive: true });
  const projectId = createProject({
    slug: `pc-${Date.now()}`,
    name: 'PC',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath,
  }).id as ULID;

  const app = new Hono();
  registerProjectContextRoutes(app, {
    resolveProject: () => ({ folderPath }),
    getProjectFolderPath: () => folderPath,
  });

  const before = getLiveEventHighWater() ?? '0';
  const res = await app.request(`/api/projects/${projectId}/claude-md`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '# Hello\n' }),
  });
  assert.equal(res.status, 200);

  // File written.
  assert.equal(readFileSync(resolve(folderPath, 'CLAUDE.md'), 'utf-8'), '# Hello\n');

  // Durable outbox row.
  const rows = listLiveOutboxRowsAfter(before, 500);
  const row = rows.find((r) => r.entity === 'project-claude-md' && r.projectId === projectId);
  assert.ok(row, 'expected a project-claude-md row in the live outbox');
  assert.equal(row?.type, 'project.claude-md.changed');
  assert.equal(row?.scope, 'project');
});
