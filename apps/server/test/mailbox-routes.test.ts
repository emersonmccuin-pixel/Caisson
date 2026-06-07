import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-mailbox-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createProject, runMigrations, newId } = await import('@pc/db');
const { MailboxService } = await import('@pc/app-services');
const { registerMailboxRoutes } = await import('../src/features/mailbox/routes.ts');
const { LiveRelay } = await import('../src/services/live-relay.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

interface Fan {
  globalAll: unknown[];
  perProject: Map<string, unknown[]>;
}

// Slice 015b — the mailbox routes no longer hand-fan message frames; the relay
// delivers them from the committed outbox row. The test harness drives a relay
// over the same DB (mirroring the live 250ms drain) and asserts delivery there.
// (☠ M8/FD-7: the pending-interaction `/answer` route + service are gone.)
function makeApp() {
  const app = new Hono();
  const fan: Fan = { globalAll: [], perProject: new Map() };
  const relay = new LiveRelay({
    hub: {
      broadcastAll(msg: unknown): number {
        fan.globalAll.push(msg);
        return 1;
      },
      broadcast(projectId: string, msg: unknown): number {
        const list = fan.perProject.get(projectId) ?? [];
        list.push(msg);
        fan.perProject.set(projectId, list);
        return 1;
      },
    },
  });
  relay.primeToHead();
  registerMailboxRoutes(app, {
    mailbox: new MailboxService(),
  });
  // Drain the relay and return what reached each scope.
  const drain = () => {
    relay.drain();
    return fan;
  };
  return { app, drain, fan };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

test('enqueue → project inbox lists it → read/dismiss updates recipient state', async () => {
  const { app, drain, fan } = makeApp();
  const project = createProject({
    slug: `mbx-${Date.now()}`,
    name: 'Mailbox P',
    stages,
    folderPath: join(tmpDir, 'mbx'),
  });

  const enq = await app.request(`/api/projects/${project.id}/mailbox/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'system-notice',
      body: 'hello inbox',
      idempotencyKey: `k-${Date.now()}`,
      // user-inbox: the address kind the real delivery seam (human-flavor gates)
      // uses; the project inbox route filters to user-inbox only (pc-pty-chat-267).
      recipients: [{ address: { kind: 'user-inbox', userId: 'local-user', projectId: project.id }, channel: 'ui-inbox' }],
    }),
  });
  assert.equal(enq.status, 200);
  const enqBody = await json<{ ok: boolean; created: boolean; recipients: { id: string }[] }>(enq);
  assert.equal(enqBody.ok, true);
  assert.equal(enqBody.created, true);
  const recipientId = enqBody.recipients[0]!.id;
  // Slice 015b — the route does NOT hand-fan; the relay delivers the canonical
  // `mailbox.message.changed` frame from the committed outbox row, exactly once,
  // to this project's scope. No message frame lands on the hand `broadcasts`.
  drain();
  const projectFan = fan.perProject.get(project.id) ?? [];
  assert.equal(projectFan.length, 1, 'relay delivers exactly one frame for the project');
  assert.equal((projectFan[0] as { type: string }).type, 'live-event');
  assert.equal(
    (projectFan[0] as { event: { type: string } }).event.type,
    'mailbox.message.changed',
  );
  assert.equal(fan.globalAll.length, 0, 'project enqueue must not reach the global scope');

  const list = await app.request(`/api/projects/${project.id}/mailbox`);
  const listBody = await json<{ items: { recipient: { id: string }; message: { body: string } }[] }>(list);
  assert.equal(listBody.items.length, 1);
  assert.equal(listBody.items[0]!.message.body, 'hello inbox');

  const read = await app.request(`/api/projects/${project.id}/mailbox/recipients/${recipientId}/read`, {
    method: 'POST',
  });
  assert.equal(read.status, 200);

  const unread = await app.request(`/api/projects/${project.id}/mailbox?unreadOnly=1`);
  assert.equal((await json<{ items: unknown[] }>(unread)).items.length, 0);
});

test('a rolled-back mailbox enqueue delivers nothing (no committed outbox row)', async () => {
  const { drain, fan } = makeApp();
  const { getDb, insertLiveEvent } = await import('@pc/db');
  const project = createProject({
    slug: `mbx-rb-${Date.now()}`,
    name: 'Mailbox Rollback',
    stages,
    folderPath: join(tmpDir, 'mbx-rb'),
  });
  // createProject wrote rows; advance the relay cursor past them.
  drain();
  const baseGlobal = fan.globalAll.length;
  const baseProject = (fan.perProject.get(project.id) ?? []).length;

  // Simulate a mailbox-message outbox write that rolls back — the relay must
  // never deliver it (delivery ≡ a COMMITTED outbox row).
  assert.throws(() => {
    getDb().transaction((tx) => {
      insertLiveEvent(tx, {
        scope: 'project',
        projectId: project.id,
        type: 'mailbox.message.changed',
        entity: 'mailbox-message',
        entityId: newId(),
        version: null,
        payload: {},
      });
      throw new Error('boom — roll back');
    });
  }, /boom/);

  drain();
  assert.equal(fan.globalAll.length, baseGlobal, 'rolled-back row must not reach global');
  assert.equal((fan.perProject.get(project.id) ?? []).length, baseProject, 'rolled-back row must not reach the project');
});

test('enqueue is idempotent by key (replay → created:false)', async () => {
  const { app } = makeApp();
  const project = createProject({
    slug: `mbx-idem-${Date.now()}`,
    name: 'Mailbox Idem',
    stages,
    folderPath: join(tmpDir, 'mbx-idem'),
  });
  const key = `idem-${Date.now()}`;
  const body = JSON.stringify({
    kind: 'system-notice',
    body: 'x',
    idempotencyKey: key,
    recipients: [{ address: { kind: 'project-inbox', projectId: project.id }, channel: 'ui-inbox' }],
  });
  await app.request(`/api/projects/${project.id}/mailbox/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const second = await app.request(`/api/projects/${project.id}/mailbox/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal((await json<{ created: boolean }>(second)).created, false);
});

test('delivery inspector returns deliveries; bad request is 400', async () => {
  const { app } = makeApp();
  const project = createProject({
    slug: `mbx-del-${Date.now()}`,
    name: 'Mailbox Del',
    stages,
    folderPath: join(tmpDir, 'mbx-del'),
  });
  await app.request(`/api/projects/${project.id}/mailbox/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'system-notice',
      body: 'x',
      idempotencyKey: `dk-${Date.now()}`,
      recipients: [{ address: { kind: 'project-inbox', projectId: project.id }, channel: 'ui-inbox' }],
    }),
  });
  const inspector = await app.request(`/api/projects/${project.id}/mailbox/deliveries`);
  const body = await json<{ deliveries: { status: string }[] }>(inspector);
  assert.equal(body.deliveries.length, 1);
  assert.equal(body.deliveries[0]!.status, 'pending');

  const bad = await app.request(`/api/projects/${project.id}/mailbox/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'system-notice', body: 'x', recipients: [] }),
  });
  assert.equal(bad.status, 400);
});

test('app-level enqueue with a project-less user-inbox recipient → global inbox', async () => {
  const { app, drain, fan } = makeApp();
  const enq = await app.request('/api/mailbox/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'system-notice',
      body: 'global hello',
      idempotencyKey: `g-${Date.now()}`,
      recipients: [
        { address: { kind: 'user-inbox', userId: 'local-user', projectId: null }, channel: 'ui-inbox' },
      ],
    }),
  });
  assert.equal(enq.status, 200);
  const enqBody = await json<{ ok: boolean; message: { projectId: string | null } }>(enq);
  assert.equal(enqBody.ok, true);
  // The message is stored project-less so it lands in the global inbox…
  assert.equal(enqBody.message.projectId, null);
  // …and the relay delivers a global (`scope:'global'`) frame to all sockets.
  // The web `shouldAcceptMailboxWsEnvelope` accepts canonical frames regardless
  // of projectId, so `broadcastAll` reaches the single-user inbox consumer.
  drain();
  assert.ok(
    fan.globalAll.some(
      (m) => (m as { event?: { type?: string } }).event?.type === 'mailbox.message.changed',
    ),
    'relay delivers the global mailbox frame to all sockets',
  );

  const list = await app.request('/api/mailbox');
  const body = await json<{ items: { message: { body: string } }[] }>(list);
  assert.ok(body.items.some((i) => i.message.body === 'global hello'));
});

test('app-level enqueue derives projectId from a project-bound recipient', async () => {
  const { app } = makeApp();
  const project = createProject({
    slug: `mbx-derive-${Date.now()}`,
    name: 'Mailbox Derive',
    stages,
    folderPath: join(tmpDir, 'mbx-derive'),
  });
  const enq = await app.request('/api/mailbox/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'system-notice',
      body: 'scoped via app route',
      idempotencyKey: `d-${Date.now()}`,
      // user-inbox: the address kind the human-facing project inbox filters to
      // (pc-pty-chat-267). project-inbox is excluded from the human view.
      recipients: [{ address: { kind: 'user-inbox', userId: 'local-user', projectId: project.id }, channel: 'ui-inbox' }],
    }),
  });
  const enqBody = await json<{ message: { projectId: string | null } }>(enq);
  assert.equal(enqBody.message.projectId, project.id);
  // It is NOT in the global inbox (no project-less user-inbox recipient)…
  const global = await app.request('/api/mailbox');
  assert.ok(!(await json<{ items: { message: { body: string } }[] }>(global)).items.some(
    (i) => i.message.body === 'scoped via app route',
  ));
  // …but IS in the project inbox (user-inbox address for this project).
  const proj = await app.request(`/api/projects/${project.id}/mailbox`);
  assert.ok((await json<{ items: { message: { body: string } }[] }>(proj)).items.some(
    (i) => i.message.body === 'scoped via app route',
  ));
});

// M8 (FD-7) — /api/inbox = every user-inbox recipient across ALL projects
// (the Inbox bell's feed). Project-scoped user-inbox cards from two different
// projects both appear; non-user-inbox recipients never do.
test('GET /api/inbox aggregates user-inbox recipients across projects', async () => {
  const { app } = makeApp();
  const mk = (n: number) =>
    createProject({
      slug: `mbx-all-${String(n)}-${Date.now()}`,
      name: `Mailbox All ${String(n)}`,
      stages,
      folderPath: join(tmpDir, `mbx-all-${String(n)}`),
    });
  const pA = mk(1);
  const pB = mk(2);
  const enqueueReview = async (projectId: string, marker: string) =>
    app.request(`/api/projects/${projectId}/mailbox/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'workflow-review',
        body: marker,
        idempotencyKey: `all-${marker}`,
        recipients: [
          { address: { kind: 'user-inbox', userId: 'local-user', projectId }, channel: 'ui-inbox' },
        ],
      }),
    });
  await enqueueReview(pA.id, 'review in A');
  await enqueueReview(pB.id, 'review in B');

  const res = await app.request('/api/inbox');
  const body = await json<{ items: { message: { body: string; projectId: string | null } }[] }>(res);
  assert.ok(body.items.some((i) => i.message.body === 'review in A'));
  assert.ok(body.items.some((i) => i.message.body === 'review in B'));

  // actionableOnly filters to decision kinds.
  const actionable = await json<{ items: { message: { body: string } }[] }>(
    await app.request('/api/inbox?actionableOnly=1'),
  );
  assert.ok(actionable.items.some((i) => i.message.body === 'review in B'));
});

// pc-pty-chat-267 — project inbox must show ONLY user-inbox recipients.
// An orchestrator-reviewer workflow-review gate is addressed to active-orchestrator;
// it must NOT appear in /api/projects/:id/mailbox.  A human-reviewer gate IS
// addressed to user-inbox and MUST appear.
test('project inbox returns human-reviewer gates, excludes orchestrator-reviewer gates', async () => {
  const { app } = makeApp();
  const project = createProject({
    slug: `mbx-flavor-${Date.now()}`,
    name: 'Flavor Test',
    stages,
    folderPath: join(tmpDir, 'mbx-flavor'),
  });

  const enqueue = async (addressKind: string, addressExtra: Record<string, unknown>, body: string, key: string) =>
    app.request(`/api/projects/${project.id}/mailbox/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'workflow-review',
        body,
        idempotencyKey: key,
        recipients: [{ address: { ...addressExtra, kind: addressKind }, channel: addressKind === 'user-inbox' ? 'ui-inbox' : 'orchestrator-turn' }],
      }),
    });

  // human-flavor gate → user-inbox
  await enqueue('user-inbox', { userId: 'local-user', projectId: project.id }, 'human gate', `hg-${Date.now()}`);
  // orchestrator-flavor gate → active-orchestrator
  await enqueue('active-orchestrator', { projectId: project.id }, 'orchestrator gate', `og-${Date.now()}`);

  const res = await app.request(`/api/projects/${project.id}/mailbox`);
  const body = await json<{ items: { message: { body: string } }[] }>(res);

  assert.ok(body.items.some((i) => i.message.body === 'human gate'), 'human gate must appear in project inbox');
  assert.ok(!body.items.some((i) => i.message.body === 'orchestrator gate'), 'orchestrator gate must NOT appear in project inbox');
});

// ☠ M8/FD-7: the pending-interaction answer route is gone with the shadow
// table — it must 404 like any unknown route.
test('pending-interaction answer route stays deleted (404)', async () => {
  const { app } = makeApp();
  const project = createProject({
    slug: `mbx-int-${Date.now()}`,
    name: 'Mailbox Int',
    stages,
    folderPath: join(tmpDir, 'mbx-int'),
  });
  const res = await app.request(`/api/projects/${project.id}/pending-interactions/x/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'y', answeredBy: 'user' }),
  });
  assert.equal(res.status, 404);
});
