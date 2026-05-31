import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';

import type { RuntimeTurnPort } from '../src/conversations/index.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-conv-send-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  newId,
  runMigrations,
} = await import('@pc/db');
const { ConversationSendService } = await import('../src/conversations/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

interface Harness {
  service: InstanceType<typeof ConversationSendService>;
  projectId: ULID;
  sessionId: ULID;
  snapshots: Array<{ projectId: string; sessionId: string }>;
  setState(state: string): void;
}

function mkHarness(opts: { state?: string; port?: RuntimeTurnPort | null; sends?: string[] } = {}): Harness {
  const project = createProject({
    slug: `conv-${newId()}`,
    name: 'Conv',
    stages,
    folderPath: join(tmpDir, `conv-${newId()}`),
  });
  const session = createOrchestratorSession({ projectId: project.id, providerSessionId: `uuid-${newId()}` });
  const snapshots: Array<{ projectId: string; sessionId: string }> = [];
  const sends = opts.sends ?? [];
  let state = opts.state ?? 'ready';
  const defaultPort: RuntimeTurnPort = {
    getState: () => state,
    send: async (text) => {
      sends.push(text);
      return 'ok';
    },
  };
  const port = opts.port === undefined ? defaultPort : opts.port;
  const service = new ConversationSendService({
    getPort: () => port,
    ensurePort: () => {
      if (!port) throw new Error('no pty');
      return port;
    },
    ensureActiveSession: () => session,
    broadcastSendQueueSnapshot: (projectId, sessionId) => snapshots.push({ projectId, sessionId }),
  });
  return { service, projectId: project.id, sessionId: session.id, snapshots, setState: (s) => { state = s; } };
}

test('sendUserTurn: ready + no backlog -> received + delivered_to_pty', async () => {
  const sends: string[] = [];
  const h = mkHarness({ state: 'ready', sends });
  const res = await h.service.sendUserTurn({ projectId: h.projectId, text: 'hi', clientMessageId: 'cm1' });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.status, 'received');
    assert.equal(res.row.status, 'delivered_to_pty');
  }
  assert.deepEqual(sends, ['hi']);
});

test('sendUserTurn: busy -> queued_busy; spawning -> queued_spawning', async () => {
  const busy = mkHarness({ state: 'busy' });
  const r1 = await busy.service.sendUserTurn({ projectId: busy.projectId, text: 'q', clientMessageId: 'cmb' });
  assert.equal(r1.ok && r1.status, 'queued');
  if (r1.ok) assert.equal(r1.row.status, 'queued_busy');

  const spawning = mkHarness({ state: 'spawning' });
  const r2 = await spawning.service.sendUserTurn({ projectId: spawning.projectId, text: 'q', clientMessageId: 'cms' });
  if (r2.ok) assert.equal(r2.row.status, 'queued_spawning');
});

test('sendUserTurn: ready but existing backlog -> queued_backlog', async () => {
  const h = mkHarness({ state: 'busy' });
  await h.service.sendUserTurn({ projectId: h.projectId, text: 'first', clientMessageId: 'cm1' });
  h.setState('ready');
  const r = await h.service.sendUserTurn({ projectId: h.projectId, text: 'second', clientMessageId: 'cm2' });
  if (r.ok) assert.equal(r.row.status, 'queued_backlog');
});

test('sendUserTurn: no pty available -> no-session', async () => {
  const h = mkHarness({ port: null });
  const r = await h.service.sendUserTurn({ projectId: h.projectId, text: 'x', clientMessageId: 'cm' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 'no-session');
});

test('enqueueRuntimeTurn: idempotent by (sessionId, clientMessageId) and never raw-sends', async () => {
  const sends: string[] = [];
  const h = mkHarness({ state: 'ready', sends });
  const first = h.service.enqueueRuntimeTurn({
    projectId: h.projectId,
    sessionId: h.sessionId,
    clientMessageId: 'mb1',
    text: 'mailbox turn',
    source: 'mailbox',
    sourceRef: 'msg-1',
  });
  assert.equal(first.created, true);
  // no raw send happened even though state is 'ready'
  assert.deepEqual(sends, []);
  // replay returns the SAME row, no new insert
  const replay = h.service.enqueueRuntimeTurn({
    projectId: h.projectId,
    sessionId: h.sessionId,
    clientMessageId: 'mb1',
    text: 'mailbox turn',
    source: 'mailbox',
  });
  assert.equal(replay.created, false);
  assert.equal(replay.row.id, first.row.id);
});

test('observeUserJsonl: marks the first FIFO delivered match observed_in_jsonl once', async () => {
  const sends: string[] = [];
  const h = mkHarness({ state: 'ready', sends });
  const sent = await h.service.sendUserTurn({ projectId: h.projectId, text: 'echo me', clientMessageId: 'cm1' });
  assert.equal(sent.ok && sent.row.status, 'delivered_to_pty');

  const observed = h.service.observeUserJsonl({
    projectId: h.projectId,
    sessionId: h.sessionId,
    event: { kind: 'jsonl-user', text: 'echo me' },
  });
  assert.ok(observed);
  assert.equal(observed!.status, 'observed_in_jsonl');
  assert.equal(observed!.clientMessageId, 'cm1');

  // second observation of the same text finds no more delivered rows
  const again = h.service.observeUserJsonl({
    projectId: h.projectId,
    sessionId: h.sessionId,
    event: { kind: 'jsonl-user', text: 'echo me' },
  });
  assert.equal(again, undefined);
});

test('cancelQueuedTurn only cancels queued; retryFailedTurn only retries failed', async () => {
  const h = mkHarness({ state: 'busy' });
  const queued = await h.service.sendUserTurn({ projectId: h.projectId, text: 'q', clientMessageId: 'cm1' });
  assert.equal(queued.ok && queued.row.status, 'queued_busy');
  const sendId = (queued.ok ? queued.row.id : '') as ULID;

  const cancelled = h.service.cancelQueuedTurn({ sendId, sessionId: h.sessionId, reason: 'user cancelled' });
  assert.equal(cancelled?.status, 'cancelled');

  // retry on a cancelled row is a no-op (not failed)
  const retry = h.service.retryFailedTurn({ sendId, sessionId: h.sessionId, state: 'ready', hasBacklog: false });
  assert.equal(retry, undefined);
});

test('listVisibleTurns surfaces open + failed rows', async () => {
  const h = mkHarness({ state: 'busy' });
  await h.service.sendUserTurn({ projectId: h.projectId, text: 'a', clientMessageId: 'cm1' });
  await h.service.sendUserTurn({ projectId: h.projectId, text: 'b', clientMessageId: 'cm2' });
  const visible = h.service.listVisibleTurns(h.sessionId);
  assert.equal(visible.length, 2);
});

test('deliverNextQueuedTurnOnce: an echo-timeout failure does NOT wedge the queue — it marks the head failed and drains the next', async () => {
  // Regression for slice-006 live defect: while the orchestrator was busy the
  // user queued several turns; delivery of the head returned echo-timeout
  // (non-ok). Pre-fix the drain stopped, stranding the remaining queued turns
  // (footer stuck on "N queued prompt pending"). The drain must instead mark the
  // head failed and CONTINUE to the next queued row.
  const sends: string[] = [];
  let calls = 0;
  let state = 'busy';
  const port: RuntimeTurnPort = {
    getState: () => state,
    send: async (text) => {
      calls += 1;
      // First delivered turn echo-times-out; everything after sends ok.
      if (calls === 1) return 'echo-timeout';
      sends.push(text);
      return 'ok';
    },
  };
  // Build the harness busy so all turns enqueue, then flip ready and drain.
  const h = mkHarness({ port });
  await h.service.sendUserTurn({ projectId: h.projectId, text: 'testing', clientMessageId: 'cm1' });
  await h.service.sendUserTurn({ projectId: h.projectId, text: 'testing', clientMessageId: 'cm2' });
  await h.service.sendUserTurn({ projectId: h.projectId, text: 'okay', clientMessageId: 'cm3' });
  state = 'ready';

  await h.service.deliverNextQueuedTurnOnce(h.projectId, h.sessionId);

  const visible = h.service.listVisibleTurns(h.sessionId);
  const failed = visible.filter((r) => r.status === 'failed');
  const delivered = visible.filter((r) => r.status === 'delivered_to_pty');
  const stillQueued = visible.filter((r) => r.status.startsWith('queued_'));

  // The head failed; the queue did NOT wedge — the next turn was delivered and
  // a success stops the loop pending its jsonl-user correlation.
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.text, 'testing');
  assert.equal(failed[0]!.failureReason, 'send returned echo-timeout');
  assert.equal(delivered.length, 1);
  // exactly one queued turn remains (drain stopped on the first SUCCESS, FIFO).
  assert.equal(stillQueued.length, 1);
  // Discrete turns stay discrete rows — no concatenation/glue at the queue layer.
  assert.deepEqual(sends, ['testing']);
});

test('deliverNextQueuedTurnOnce: a queue of nothing-but-failures fully drains (no wedge) and ends with no open rows', async () => {
  let state = 'busy';
  const port: RuntimeTurnPort = {
    getState: () => state,
    send: async () => 'echo-timeout',
  };
  const h = mkHarness({ port });
  await h.service.sendUserTurn({ projectId: h.projectId, text: 'a', clientMessageId: 'cm1' });
  await h.service.sendUserTurn({ projectId: h.projectId, text: 'b', clientMessageId: 'cm2' });
  state = 'ready';

  await h.service.deliverNextQueuedTurnOnce(h.projectId, h.sessionId);

  const visible = h.service.listVisibleTurns(h.sessionId);
  // both turns terminalized failed; nothing left queued/delivering (no wedge).
  assert.equal(visible.filter((r) => r.status === 'failed').length, 2);
  assert.equal(visible.filter((r) => r.status.startsWith('queued_')).length, 0);
  assert.equal(visible.filter((r) => r.status === 'delivering').length, 0);
});

test('deliverNextQueuedTurnOnce delivers exactly one queued row when ready', async () => {
  const sends: string[] = [];
  const h = mkHarness({ state: 'busy', sends });
  await h.service.sendUserTurn({ projectId: h.projectId, text: 'first', clientMessageId: 'cm1' });
  await h.service.sendUserTurn({ projectId: h.projectId, text: 'second', clientMessageId: 'cm2' });
  h.setState('ready');
  await h.service.deliverNextQueuedTurnOnce(h.projectId, h.sessionId);
  // exactly one of the two queued turns was drained to the pty
  assert.equal(sends.length, 1);
  const visible = h.service.listVisibleTurns(h.sessionId);
  const delivered = visible.filter((r) => r.status === 'delivered_to_pty');
  const stillQueued = visible.filter((r) => r.status.startsWith('queued_'));
  assert.equal(delivered.length, 1);
  assert.equal(stillQueued.length, 1);
  assert.equal(delivered[0]!.text, sends[0]);
});
