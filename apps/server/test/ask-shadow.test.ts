import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

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
  // Slice 015b — the shadow no longer hand-fans; pending-interaction.changed
  // frames ride the relay from the committed outbox row.
  const askShadow = new AskShadow();
  registerChatBridgeRoutes(app, {
    broadcastTo: () => {},
    pendingAsks,
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

test('onAsk + onResolved each ride the relay exactly once (no hand-fanout), project-scoped', async () => {
  const { LiveRelay } = await import('../src/services/live-relay.ts');
  const fanProject = new Map<string, unknown[]>();
  const fanGlobal: unknown[] = [];
  const relay = new LiveRelay({
    hub: {
      broadcastAll(msg: unknown): number { fanGlobal.push(msg); return 1; },
      broadcast(pid: string, msg: unknown): number {
        const l = fanProject.get(pid) ?? [];
        l.push(msg);
        fanProject.set(pid, l);
        return 1;
      },
    },
  });
  relay.primeToHead();

  const project = createProject({
    slug: `ask-relay-${Date.now()}`,
    name: 'Ask Relay',
    stages,
    folderPath: join(tmpDir, 'ask-relay'),
  });
  relay.drain(); // advance past createProject's outbox rows
  const base = (fanProject.get(project.id) ?? []).length;

  const shadow = new AskShadow();
  const toolUseId = `tool-relay-${Date.now()}`;
  shadow.onAsk({ projectId: project.id, toolUseId, toolName: 'AskUserQuestion', prompt: 'pick?' });

  relay.drain();
  const afterAsk = (fanProject.get(project.id) ?? []).slice(base);
  assert.equal(afterAsk.length, 1, 'create delivers exactly one frame via the relay');
  assert.equal(
    (afterAsk[0] as { event: { type: string } }).event.type,
    'pending-interaction.changed',
  );
  assert.equal(fanGlobal.length, 0, 'pending-interactions are project-scoped, never global');

  shadow.onResolved(toolUseId, 'yes');
  relay.drain();
  const afterResolve = (fanProject.get(project.id) ?? []).slice(base);
  assert.equal(afterResolve.length, 2, 'terminalize delivers a second frame via the relay');
});

test('a rolled-back pending-interaction write delivers nothing', async () => {
  const { getDb, insertLiveEvent } = db;
  const { LiveRelay } = await import('../src/services/live-relay.ts');
  const fanProject = new Map<string, unknown[]>();
  const relay = new LiveRelay({
    hub: {
      broadcastAll(): number { return 1; },
      broadcast(pid: string, msg: unknown): number {
        const l = fanProject.get(pid) ?? [];
        l.push(msg);
        fanProject.set(pid, l);
        return 1;
      },
    },
  });
  relay.primeToHead();
  const project = createProject({
    slug: `ask-rb-${Date.now()}`,
    name: 'Ask Rollback',
    stages,
    folderPath: join(tmpDir, 'ask-rb'),
  });
  relay.drain();
  const base = (fanProject.get(project.id) ?? []).length;

  assert.throws(() => {
    getDb().transaction((tx) => {
      insertLiveEvent(tx, {
        scope: 'project',
        projectId: project.id,
        type: 'pending-interaction.changed',
        entity: 'pending-interaction',
        entityId: newId(),
        version: 0,
        payload: {},
      });
      throw new Error('boom — roll back');
    });
  }, /boom/);

  relay.drain();
  assert.equal((fanProject.get(project.id) ?? []).length, base, 'rolled-back row never delivers');
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
