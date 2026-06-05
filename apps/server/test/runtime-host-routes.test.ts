import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-runtime-host-routes-'));
process.env.PC_DATA_DIR = tmpDir;

const { appendConversationEvent, closeDb, runMigrations } = await import('@pc/db');
const { registerRuntimeHostRoutes } = await import('../src/features/runtime-host/routes.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const projectId = 'p-routes';
const sessionId = 's-routes';

// M3b — replay reads come from conversation_events; seed rows, not files.
let seeded = false;
function seedConversationEvents(): void {
  if (seeded) return;
  seeded = true;
  const rows = [
    { seq: 1, kind: 'jsonl-user', text: 'one' },
    { seq: 2, kind: 'jsonl-assistant', text: 'two' },
    { seq: 3, kind: 'jsonl-user', text: 'three' },
  ];
  for (const r of rows) {
    appendConversationEvent({
      sessionId,
      seq: r.seq,
      type: 'jsonl',
      kind: r.kind,
      event: { kind: r.kind, text: r.text },
      sourceKind: 'claude-jsonl',
      sourceCursor: r.seq,
      now: 1000 + r.seq,
    });
  }
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
  events: Array<{ id: string; seq: number; source: { kind: string; cursor: number | null } }>;
}

test('GET /sessions/:id/events returns the full checkpoint from the DB', async () => {
  seedConversationEvents();
  const app = mkApp();
  const res = await app.request(`/api/projects/${projectId}/sessions/${sessionId}/events`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as EventsBody;
  assert.equal(body.ok, true);
  assert.equal(body.sessionId, sessionId);
  assert.equal(body.highWaterSeq, 3);
  assert.deepEqual(body.events.map((e) => e.seq), [1, 2, 3]);
  // Envelope shape preserved: id + source {kind, cursor}.
  assert.equal(body.events[0]!.id, `${sessionId}:1`);
  assert.deepEqual(body.events[0]!.source, { kind: 'claude-jsonl', cursor: 1 });
});

test('GET /sessions/:id/events?afterSeq= trims to seq > afterSeq, same envelope', async () => {
  seedConversationEvents();
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
  seedConversationEvents();
  const app = mkApp();
  const full = (await (await app.request(`/api/projects/${projectId}/sessions/${sessionId}/events`)).json()) as EventsBody;
  const zero = (await (await app.request(`/api/projects/${projectId}/sessions/${sessionId}/events?afterSeq=0`)).json()) as EventsBody;
  assert.deepEqual(zero.events, full.events);

  const empty = (await (await app.request(`/api/projects/${projectId}/sessions/${sessionId}/events?afterSeq=3`)).json()) as EventsBody;
  assert.deepEqual(empty.events, []);
  assert.equal(empty.highWaterSeq, 3);
});

test('afterSeq with limit caps oldest-first', async () => {
  seedConversationEvents();
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
