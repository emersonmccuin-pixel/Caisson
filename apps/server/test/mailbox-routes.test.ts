import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-mailbox-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createProject, runMigrations, listDeliveriesForProject, getPendingInteraction, createPendingInteraction, newId } =
  await import('@pc/db');
const { MailboxService, PendingInteractionService } = await import('@pc/app-services');
const { registerMailboxRoutes } = await import('../src/features/mailbox/routes.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

function makeApp() {
  const app = new Hono();
  const broadcasts: { projectId: ULID | null; event: unknown }[] = [];
  registerMailboxRoutes(app, {
    mailbox: new MailboxService(),
    interactions: new PendingInteractionService(),
    broadcastTo: (projectId, event) => broadcasts.push({ projectId, event }),
    broadcastAll: (event) => broadcasts.push({ projectId: null, event }),
  });
  return { app, broadcasts };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

test('enqueue → project inbox lists it → read/dismiss updates recipient state', async () => {
  const { app, broadcasts } = makeApp();
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
      recipients: [{ address: { kind: 'project-inbox', projectId: project.id }, channel: 'ui-inbox' }],
    }),
  });
  assert.equal(enq.status, 200);
  const enqBody = await json<{ ok: boolean; created: boolean; recipients: { id: string }[] }>(enq);
  assert.equal(enqBody.ok, true);
  assert.equal(enqBody.created, true);
  const recipientId = enqBody.recipients[0]!.id;
  // enqueue fanned out a canonical frame
  assert.ok(broadcasts.some((b) => b.projectId === project.id));

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
  const { app, broadcasts } = makeApp();
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
  // …and fanned out on the global (project-less) channel.
  assert.ok(broadcasts.some((b) => b.projectId === null));

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
      recipients: [{ address: { kind: 'project-inbox', projectId: project.id }, channel: 'ui-inbox' }],
    }),
  });
  const enqBody = await json<{ message: { projectId: string | null } }>(enq);
  assert.equal(enqBody.message.projectId, project.id);
  // It is NOT in the global inbox…
  const global = await app.request('/api/mailbox');
  assert.ok(!(await json<{ items: { message: { body: string } }[] }>(global)).items.some(
    (i) => i.message.body === 'scoped via app route',
  ));
  // …but IS in the project inbox.
  const proj = await app.request(`/api/projects/${project.id}/mailbox`);
  assert.ok((await json<{ items: { message: { body: string } }[] }>(proj)).items.some(
    (i) => i.message.body === 'scoped via app route',
  ));
});

test('answer a pending interaction route (404 unknown, 200 ok, 409 already terminal)', async () => {
  const { app } = makeApp();
  const project = createProject({
    slug: `mbx-int-${Date.now()}`,
    name: 'Mailbox Int',
    stages,
    folderPath: join(tmpDir, 'mbx-int'),
  });
  const missing = await app.request(`/api/projects/${project.id}/pending-interactions/nope/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'y', answeredBy: 'user' }),
  });
  assert.equal(missing.status, 404);

  const interaction = createPendingInteraction({
    id: newId(),
    projectId: project.id,
    kind: 'runtime-hook-ask',
    sourceKind: 'runtime-hook',
    sourceId: `tool-${Date.now()}`,
    prompt: 'pick',
    now: Date.now(),
  });
  const ok = await app.request(`/api/projects/${project.id}/pending-interactions/${interaction.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'yes', answeredBy: 'user' }),
  });
  assert.equal(ok.status, 200);
  assert.equal(getPendingInteraction(interaction.id)!.status, 'answered');

  const replay = await app.request(`/api/projects/${project.id}/pending-interactions/${interaction.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'no', answeredBy: 'user' }),
  });
  assert.equal(replay.status, 409);
});
