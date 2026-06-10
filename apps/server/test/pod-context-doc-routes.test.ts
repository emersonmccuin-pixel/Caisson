// Migration 0055 — agent context-doc routes (replaced the /knowledge family).
//
// Covers: pod-route CRUD + bundle shape, audit rows landing with field
// 'context-doc', rev bump on mutation, 404 on cross-pod docId, and the
// project-route DELETE keeping agent surfaces in sync.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-pod-ctx-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createAgent, getAgentById, listAgentAudit, runMigrations } =
  await import('@pc/db');
const { getPodBundle, registerPodRoutes } = await import('../src/routes/pod-routes.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp() {
  const app = new Hono();
  registerPodRoutes(app, {});
  return app;
}

let counter = 0;
function makeAgent() {
  counter += 1;
  return createAgent(
    { name: `ctx-doc-agent-${counter}`, scope: 'global', prompt: '' },
    { actor: 'user', reason: 'test' },
  );
}

async function createDoc(app: Hono, agentId: ULID, title: string, body = '') {
  const res = await app.request(`/api/agents/pods/${agentId}/context-docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, body }),
  });
  assert.equal(res.status, 201);
  const json = (await res.json()) as { ok: boolean; contextDoc: { id: ULID; title: string } };
  assert.equal(json.ok, true);
  return json.contextDoc;
}

test('POST + GET round-trip; bundle carries contextDocs', async () => {
  const app = makeApp();
  const agent = makeAgent();
  const doc = await createDoc(app, agent.id, 'Style guide', 'Always terse.');

  const res = await app.request(`/api/agents/pods/${agent.id}/context-docs/${doc.id}`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { contextDoc: { title: string; body: string; agentId: string } };
  assert.equal(json.contextDoc.title, 'Style guide');
  assert.equal(json.contextDoc.body, 'Always terse.');
  assert.equal(json.contextDoc.agentId, agent.id);

  const bundle = getPodBundle(agent.id);
  assert.ok(bundle);
  assert.equal(bundle!.contextDocs.length, 1);
  assert.equal(bundle!.contextDocs[0]!.id, doc.id);
});

test('GET list returns only this pod docs', async () => {
  const app = makeApp();
  const a = makeAgent();
  const b = makeAgent();
  const docA = await createDoc(app, a.id, 'A doc');
  await createDoc(app, b.id, 'B doc');

  const res = await app.request(`/api/agents/pods/${a.id}/context-docs`);
  const json = (await res.json()) as { contextDocs: { id: string }[] };
  assert.equal(json.contextDocs.length, 1);
  assert.equal(json.contextDocs[0]!.id, docA.id);
});

test('PATCH updates and DELETE soft-deletes; both bump rev', async () => {
  const app = makeApp();
  const agent = makeAgent();
  const doc = await createDoc(app, agent.id, 'Before');
  const revAfterCreate = getAgentById(agent.id)!.rev;

  const patchRes = await app.request(
    `/api/agents/pods/${agent.id}/context-docs/${doc.id}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'After', body: 'v2' }),
    },
  );
  assert.equal(patchRes.status, 200);
  const patched = (await patchRes.json()) as { contextDoc: { title: string } };
  assert.equal(patched.contextDoc.title, 'After');
  const revAfterPatch = getAgentById(agent.id)!.rev;
  assert.ok(revAfterPatch > revAfterCreate, 'PATCH must bump rev');

  const delRes = await app.request(
    `/api/agents/pods/${agent.id}/context-docs/${doc.id}`,
    { method: 'DELETE' },
  );
  assert.equal(delRes.status, 200);
  assert.ok(getAgentById(agent.id)!.rev > revAfterPatch, 'DELETE must bump rev');

  const gone = await app.request(`/api/agents/pods/${agent.id}/context-docs/${doc.id}`);
  assert.equal(gone.status, 404);
  assert.equal(getPodBundle(agent.id)!.contextDocs.length, 0);
});

test('mutations land agent_audit rows with field context-doc', async () => {
  const app = makeApp();
  const agent = makeAgent();
  const doc = await createDoc(app, agent.id, 'Audited', 'v1');
  await app.request(`/api/agents/pods/${agent.id}/context-docs/${doc.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'v2', actor: 'orchestrator', reason: 'mcp-edit' }),
  });
  await app.request(
    `/api/agents/pods/${agent.id}/context-docs/${doc.id}?actor=user&reason=prune`,
    { method: 'DELETE' },
  );

  const rows = listAgentAudit({ agentId: agent.id, field: 'context-doc' });
  const forDoc = rows.filter((r) => r.fieldRef === doc.id);
  assert.equal(forDoc.length, 3, 'create + patch + delete each audit');
  // Newest-first.
  assert.equal(forDoc[0]!.actor, 'user');
  assert.equal(forDoc[0]!.reason, 'prune');
  assert.equal(forDoc[1]!.actor, 'orchestrator');
  assert.equal(forDoc[1]!.reason, 'mcp-edit');
});

test('cross-pod docId 404s on read, patch, delete', async () => {
  const app = makeApp();
  const a = makeAgent();
  const b = makeAgent();
  const doc = await createDoc(app, a.id, 'A doc');

  const read = await app.request(`/api/agents/pods/${b.id}/context-docs/${doc.id}`);
  assert.equal(read.status, 404);
  const patch = await app.request(`/api/agents/pods/${b.id}/context-docs/${doc.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'hijack' }),
  });
  assert.equal(patch.status, 404);
  const del = await app.request(`/api/agents/pods/${b.id}/context-docs/${doc.id}`, {
    method: 'DELETE',
  });
  assert.equal(del.status, 404);
});

test('POST without title 400s', async () => {
  const app = makeApp();
  const agent = makeAgent();
  const res = await app.request(`/api/agents/pods/${agent.id}/context-docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'no title' }),
  });
  assert.equal(res.status, 400);
});

// ── Phase B (0056) — read receipts ────────────────────────────────────────────

test('GET with readVia=tool records a receipt; plain GET does not', async () => {
  const app = makeApp();
  const agent = makeAgent();
  const doc = await createDoc(app, agent.id, 'Tracked doc', 'body');

  const freshList = await app.request(`/api/agents/pods/${agent.id}/context-docs`);
  const fresh = (await freshList.json()) as {
    contextDocs: { id: string; readCount: number; lastReadAt: number | null }[];
  };
  assert.equal(fresh.contextDocs[0]!.readCount, 0, 'starts never-read');
  assert.equal(fresh.contextDocs[0]!.lastReadAt, null);

  // Plain GET (UI shape) — never counted.
  await app.request(`/api/agents/pods/${agent.id}/context-docs/${doc.id}`);
  // Tool GET with a run id — counted as an agent-run tool read.
  await app.request(
    `/api/agents/pods/${agent.id}/context-docs/${doc.id}?readVia=tool&agentRunId=01RUN000000000000000000000`,
  );
  // Tool GET without a run id — counted as an orchestrator read.
  await app.request(
    `/api/agents/pods/${agent.id}/context-docs/${doc.id}?readVia=tool`,
  );

  const after = await app.request(`/api/agents/pods/${agent.id}/context-docs`);
  const stats = (await after.json()) as {
    contextDocs: { id: string; readCount: number; lastReadAt: number | null }[];
  };
  assert.equal(stats.contextDocs[0]!.readCount, 2, 'two tool reads, plain GET ignored');
  assert.ok((stats.contextDocs[0]!.lastReadAt ?? 0) > 0);
});
