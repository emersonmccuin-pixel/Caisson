import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-ask-shadow-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('@pc/db');
const { closeDb, createProject, findOpenPendingInteractionBySource, getPendingInteraction, createPendingInteraction, newId, runMigrations } =
  db;
const { createPendingAskStore, registerChatBridgeRoutes } = await import('../src/features/chat-bridges/routes.ts');
const { AskShadow, sweepOrphanedPendingInteractions } = await import('../src/services/ask-shadow.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function setup(opts: { askTimeoutMs?: number; realTimeout?: boolean } = {}) {
  const app = new Hono();
  const pendingAsks = createPendingAskStore();
  const askShadow = new AskShadow({ broadcastTo: () => {} });
  registerChatBridgeRoutes(app, {
    broadcastTo: () => {},
    pendingAsks,
    resolveProject: () => ({ project: { slug: 'x' } }),
    channelPort: 0,
    askShadow,
    // Default: a no-op scheduler so the long timeout never holds the process
    // open (the resolver-wins tests don't rely on it). The timeout test opts in
    // to a real short timer via `realTimeout`.
    scheduleAskTimeout: opts.realTimeout ? setTimeout : () => 0,
    ...(opts.askTimeoutMs !== undefined ? { askTimeoutMs: opts.askTimeoutMs } : {}),
  });
  return { app, pendingAsks, askShadow };
}

test('/api/ask creates an open shadow row, blocks, resolves with the answer, terminalizes answered', async () => {
  const { app, pendingAsks, askShadow } = setup();
  const project = createProject({
    slug: `ask-${Date.now()}`,
    name: 'Ask P',
    stages,
    folderPath: join(tmpDir, 'ask'),
  });
  const toolUseId = `tool-${Date.now()}`;

  const askPromise = app.request('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, toolName: 'AskUserQuestion', toolUseId, toolInput: { question: 'pick?' } }),
  });

  // Give the route a tick to write the shadow + register the resolver.
  await new Promise((r) => setTimeout(r, 20));
  const open = findOpenPendingInteractionBySource('runtime-hook', toolUseId);
  assert.ok(open, 'shadow row should be open');
  assert.equal(open!.status, 'open');
  assert.equal(open!.projectId, project.id);

  // Resolve via the same path index.ts uses (resolve the in-memory store, then
  // terminalize the shadow).
  const resolved = pendingAsks.resolve(toolUseId, 'the answer');
  assert.equal(resolved, true);
  askShadow.onResolved(toolUseId, 'the answer');

  const res = await askPromise;
  assert.deepEqual(await json(res), { answer: 'the answer' });
  assert.equal(getPendingInteraction(open!.id)!.status, 'answered');
  assert.equal(getPendingInteraction(open!.id)!.answerBody, 'the answer');
});

test('/api/ask timeout terminalizes the shadow expired with the current timeout text', async () => {
  const { app } = setup({ askTimeoutMs: 5, realTimeout: true });
  const project = createProject({
    slug: `ask-to-${Date.now()}`,
    name: 'Ask Timeout',
    stages,
    folderPath: join(tmpDir, 'ask-to'),
  });
  const toolUseId = `tool-to-${Date.now()}`;
  const res = await app.request('/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, toolName: 'AskUserQuestion', toolUseId, toolInput: {} }),
  });
  assert.deepEqual(await json(res), { answer: '(timeout — no user response)' });
  const row = db.listPendingInteractionsForProject(project.id).find((r) => r.sourceId === toolUseId);
  assert.equal(row!.status, 'expired');
});

test('boot-sweep expires orphaned open shadow rows', () => {
  const project = createProject({
    slug: `sweep-${Date.now()}`,
    name: 'Sweep P',
    stages,
    folderPath: join(tmpDir, 'sweep'),
  });
  const orphan = createPendingInteraction({
    id: newId(),
    projectId: project.id,
    kind: 'runtime-hook-ask',
    sourceKind: 'runtime-hook',
    sourceId: `orphan-${Date.now()}`,
    prompt: 'lost',
    now: Date.now(),
  });
  const swept = sweepOrphanedPendingInteractions();
  assert.ok(swept >= 1);
  assert.equal(getPendingInteraction(orphan.id)!.status, 'expired');
});
