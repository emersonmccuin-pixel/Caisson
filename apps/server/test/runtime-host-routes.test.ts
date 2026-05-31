import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-runtime-host-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations } = await import('@pc/db');
const { registerRuntimeHostRoutes } = await import('../src/features/runtime-host/routes.ts');
const { loadSessionReplayCheckpoint } = await import('../src/services/session-replay.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const projectId = 'p-routes';
const sessionId = 's-routes';
const sessionDataDir = join(tmpDir, 'session-data', sessionId);

function writeJsonlEvents(): void {
  mkdirSync(sessionDataDir, { recursive: true });
  const rows = [
    { type: 'jsonl', id: `${sessionId}:1`, sessionId, seq: 1, kind: 'jsonl-user', event: { kind: 'jsonl-user', text: 'one' } },
    'this is not json',
    { type: 'jsonl', id: `${sessionId}:2`, sessionId, seq: 2, kind: 'jsonl-assistant', event: { kind: 'jsonl-assistant', text: 'two' } },
    { type: 'jsonl', id: `${sessionId}:3`, sessionId, seq: 3, kind: 'jsonl-user', event: { kind: 'jsonl-user', text: 'three' } },
  ];
  const text = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
  writeFileSync(join(sessionDataDir, 'jsonl-events.jsonl'), text, 'utf-8');
}

function mkApp(): Hono {
  const app = new Hono();
  const runtime = {
    project: { id: projectId, slug: 'routes' },
    sessionDataPath: (sid: string) => join(tmpDir, 'session-data', sid),
  };
  registerRuntimeHostRoutes(app, {
    resolveProject: (id) => (id === projectId ? (runtime as never) : null),
    runtimeSnapshotPayload: () => ({}) as never,
    broadcastTo: () => {},
    broadcastRuntimeSnapshot: () => {},
    broadcastSendQueueSnapshot: () => {},
    ensureOrchestratorPty: () => ({ getState: () => 'ready', send: () => 'ok' }) as never,
    startOrchestratorPtyInBackground: () => {},
  });
  return app;
}

interface EventsBody {
  ok: true;
  sessionId: string;
  highWaterSeq: number;
  events: Array<{ id: string; seq: number }>;
}

test('GET /sessions/:id/events returns the byte-identical full checkpoint', async () => {
  writeJsonlEvents();
  const app = mkApp();
  const res = await app.request(`/api/projects/${projectId}/sessions/${sessionId}/events`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as EventsBody;
  // identical to loadSessionReplayCheckpoint over the same dir
  const direct = loadSessionReplayCheckpoint(sessionDataDir, sessionId);
  assert.equal(body.ok, true);
  assert.equal(body.sessionId, direct.sessionId);
  assert.equal(body.highWaterSeq, direct.highWaterSeq);
  assert.deepEqual(body.events, direct.events);
  // malformed row skipped -> 3 valid events
  assert.deepEqual(body.events.map((e) => e.seq), [1, 2, 3]);
});

test('GET /sessions/:id/events?afterSeq= trims to seq > afterSeq, same envelope', async () => {
  writeJsonlEvents();
  const app = mkApp();
  const res = await app.request(
    `/api/projects/${projectId}/sessions/${sessionId}/events?afterSeq=1`,
  );
  const body = (await res.json()) as EventsBody;
  assert.deepEqual(body.events.map((e) => e.seq), [2, 3]);
  // highWaterSeq stays the full checkpoint's high water
  assert.equal(body.highWaterSeq, 3);
});

test('afterSeq=0 equals the full checkpoint; afterSeq>=highWater is empty', async () => {
  writeJsonlEvents();
  const app = mkApp();
  const full = (await (await app.request(`/api/projects/${projectId}/sessions/${sessionId}/events`)).json()) as EventsBody;
  const zero = (await (await app.request(`/api/projects/${projectId}/sessions/${sessionId}/events?afterSeq=0`)).json()) as EventsBody;
  assert.deepEqual(zero.events, full.events);

  const empty = (await (await app.request(`/api/projects/${projectId}/sessions/${sessionId}/events?afterSeq=3`)).json()) as EventsBody;
  assert.deepEqual(empty.events, []);
  assert.equal(empty.highWaterSeq, 3);
});

test('afterSeq with limit caps oldest-first', async () => {
  writeJsonlEvents();
  const app = mkApp();
  const res = await app.request(
    `/api/projects/${projectId}/sessions/${sessionId}/events?afterSeq=0&limit=2`,
  );
  const body = (await res.json()) as EventsBody;
  assert.deepEqual(body.events.map((e) => e.seq), [1, 2]);
});

test('unknown project -> 404 (route guard preserved)', async () => {
  const app = mkApp();
  const res = await app.request(`/api/projects/nope/sessions/${sessionId}/events`);
  assert.equal(res.status, 404);
});
