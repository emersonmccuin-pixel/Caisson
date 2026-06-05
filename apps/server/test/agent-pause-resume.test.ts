// Slice 009 OBJ-2A — pause/resume gates must read the RECONCILED DB row, not
// the in-memory handle snapshot.
//
// The live bug: a fresh host-backed run's handle snapshot sits at
// queued/spawning (fed only by the unreliable event stream) long after the DB
// row reached `running`, so `recordExplicitPause`'s old `handle.getState()`
// gate returned a permanent `409 wrong-state` and the run never paused. These
// tests pin the new behavior: the gate decides on the DB row (+ an optional
// on-demand host level-read), so a stale handle no longer blocks the pause.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-server-obj2a-pause-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createAgent,
  createPendingAsk,
  getAgentRunRow,
  getPendingAsk,
  insertAgentRunRow,
  updateAgentRunStatus,
  newId,
} = await import('@pc/db');
const { ActiveRunRegistry } = await import('../src/services/agent-active-runs.ts');
const { answerPendingAsk, recordExplicitPause } = await import(
  '../src/services/pause-resume.ts'
);

import type { Stage, ULID, AgentRunStatus } from '@pc/domain';
import type { AgentRunState } from '@pc/runtime';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

let projectId: ULID;
let slug: string;

before(async () => {
  runMigrations();
  const projectFolder = join(tmpDir, 'obj2a-project');
  mkdirSync(projectFolder, { recursive: true });
  const p = createProject({
    slug: 'obj2a-pause',
    name: 'OBJ-2A Pause',
    stages,
    folderPath: projectFolder,
  });
  projectId = p.id as ULID;
  slug = p.slug;

  createAgent(
    {
      id: newId(),
      scope: 'global',
      name: 'researcher',
      prompt: 'You are a researcher.',
      tools: [],
      description: 'Lab researcher pod',
    },
    { actor: 'orchestrator', reason: 'test seed' },
  );
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// A fake handle whose getState() reports a STALE value, to prove the gates no
// longer read it. Implements only what the gates' identity/delivery path needs.
type FakeRunState = AgentRunState;

class StaleHandle extends EventEmitter {
  paused = false;
  resumeAnswers: string[] = [];
  constructor(
    private readonly runId: ULID,
    private readonly ccSessionId: string,
    private staleState: FakeRunState,
  ) {
    super();
  }
  getRecord() {
    return { agentRunId: this.runId };
  }
  getState(): FakeRunState {
    return this.staleState;
  }
  cancel() {}
  notifyMcpHandshake() {}
  async markPaused(askId: string): Promise<void> {
    this.paused = true;
    void askId;
  }
  async resumeWithAnswer(answer: string): Promise<{ ok: true }> {
    this.resumeAnswers.push(answer);
    return { ok: true };
  }
  onTerminal(listener: () => void) {
    this.once('terminal', listener);
  }
}

function seedRow(
  runId: ULID,
  ccSessionId: string,
  status: AgentRunStatus,
): void {
  insertAgentRunRow({
    id: runId,
    projectId,
    podName: 'researcher',
    dispatcherSessionId: 'orch-sess',
    ccSessionId,
    status,
    input: 'go',
    queuedAt: 1_700_000_000_000,
  });
}

function registerStale(
  reg: InstanceType<typeof ActiveRunRegistry>,
  runId: ULID,
  ccSessionId: string,
  staleState: FakeRunState,
): StaleHandle {
  const run = new StaleHandle(runId, ccSessionId, staleState);
  reg.register({
    run: run as never,
    projectId,
    dispatcherSessionId: 'orch-sess',
    ccSessionId,
    podName: 'researcher',
    podRevisionAtDispatch: null,
  });
  return run;
}

// ──────────────────────────── recordExplicitPause gate ────────────────────

test('recordExplicitPause — opens when DB row is running though handle reports queued (THE bug)', async () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const cc = `cc-${runId}`;
  seedRow(runId, cc, 'running');
  const run = registerStale(reg, runId, cc, 'queued'); // stale handle lies

  const result = await recordExplicitPause(
    { agentRunId: runId, kind: 'orchestrator', promptBody: '?', now: 1_700_000_001_000 },
    { slug, registry: reg },
  );

  assert.ok(result.ok, `expected gate to open; got ${JSON.stringify(result)}`);
  if (!result.ok) return;
  // Pause body still ran off the handle (identity) + DB flipped to paused.
  assert.equal(run.paused, true);
  assert.equal(getAgentRunRow(runId)!.status, 'paused');
  assert.equal(getPendingAsk(result.pendingAskId)!.status, 'open');
});

test('recordExplicitPause — rejects when reconciled row is genuinely not running (no host dep)', async () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const cc = `cc-${runId}`;
  seedRow(runId, cc, 'spawning'); // truly not running, no on-demand reader
  registerStale(reg, runId, cc, 'running'); // even a "running" handle must not open it

  const result = await recordExplicitPause(
    { agentRunId: runId, kind: 'orchestrator', promptBody: '?' },
    { slug, registry: reg },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cause, 'wrong-state');
});

test('recordExplicitPause — on-demand host read: row spawning + hostRunState running → opens', async () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const cc = `cc-${runId}`;
  seedRow(runId, cc, 'spawning');
  registerStale(reg, runId, cc, 'spawning');

  let calls = 0;
  const result = await recordExplicitPause(
    { agentRunId: runId, kind: 'orchestrator', promptBody: '?' },
    {
      slug,
      registry: reg,
      hostRunState: async (id) => {
        calls += 1;
        return id === runId ? ('running' as AgentRunState) : null;
      },
    },
  );
  assert.equal(calls, 1, 'expected exactly one on-demand host level-read');
  assert.ok(result.ok, `expected open; got ${JSON.stringify(result)}`);
});

test('recordExplicitPause — on-demand host read: row spawning + hostRunState spawning → 409', async () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const cc = `cc-${runId}`;
  seedRow(runId, cc, 'spawning');
  registerStale(reg, runId, cc, 'running');

  const result = await recordExplicitPause(
    { agentRunId: runId, kind: 'orchestrator', promptBody: '?' },
    {
      slug,
      registry: reg,
      hostRunState: async () => 'spawning' as AgentRunState,
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cause, 'wrong-state');
});

test('recordExplicitPause — missing handle still returns unknown-run even when row is running', async () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  seedRow(runId, `cc-${runId}`, 'running');
  // No handle registered.
  const result = await recordExplicitPause(
    { agentRunId: runId, kind: 'orchestrator', promptBody: '?' },
    { slug, registry: reg },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cause, 'unknown-run');
});

// ──────────────────────────── answerPendingAsk gate ───────────────────────

test('answerPendingAsk — gate reads reconciled paused row even when handle reports spawning', async () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const cc = `cc-${runId}`;
  const askId = newId() as ULID;
  seedRow(runId, cc, 'paused');
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: cc,
    projectId,
    kind: 'orchestrator',
    promptBody: '?',
    now: 1_700_000_000_000,
  });
  const run = registerStale(reg, runId, cc, 'spawning'); // stale handle lies

  const result = await answerPendingAsk(
    { pendingAskId: askId, answer: 'blue', answeredBy: 'orchestrator' },
    { slug, registry: reg },
  );
  assert.ok(result.ok, `expected resume; got ${JSON.stringify(result)}`);
  assert.deepEqual(run.resumeAnswers, ['blue']);
  assert.equal(getPendingAsk(askId)!.status, 'answered');
});

test('answerPendingAsk — rejects when reconciled row is not paused (handle reports paused)', async () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const cc = `cc-${runId}`;
  const askId = newId() as ULID;
  seedRow(runId, cc, 'running'); // row not paused
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: cc,
    projectId,
    kind: 'orchestrator',
    promptBody: '?',
    now: 1_700_000_000_000,
  });
  registerStale(reg, runId, cc, 'paused'); // handle lies "paused"
  // Make sure the row really is running (not flipped by anything else).
  updateAgentRunStatus({ id: runId, status: 'running' });

  const result = await answerPendingAsk(
    { pendingAskId: askId, answer: 'x', answeredBy: 'orchestrator' },
    { slug, registry: reg },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cause, 'wrong-state');
});

// ─────────────── M4b (FD-8) — decided-anywhere ask-card resolution ──────────

test('M4b — a successful answer actions the ask\'s open inbox cards (resolve-by-source)', async () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const cc = `cc-${runId}`;
  const askId = newId() as ULID;
  seedRow(runId, cc, 'paused');
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: cc,
    projectId,
    kind: 'orchestrator',
    promptBody: '?',
    now: 1_700_000_000_000,
  });
  registerStale(reg, runId, cc, 'paused');

  const collected: [string, string][] = [];
  const actioned: string[][] = [];
  const result = await answerPendingAsk(
    { pendingAskId: askId, answer: 'blue', answeredBy: 'user' },
    {
      slug,
      registry: reg,
      askInbox: {
        collectUnactionedRecipients: (kind, id) => {
          collected.push([kind, id]);
          return ['rec-1' as ULID];
        },
        actionRecipients: (ids) => {
          actioned.push([...ids]);
          return ids.length;
        },
      },
    },
  );
  assert.ok(result.ok, `expected resume; got ${JSON.stringify(result)}`);
  assert.deepEqual(collected, [['agent', askId]]);
  assert.deepEqual(actioned, [['rec-1']]);
});

test('M4b — a failed answer (wrong-state) does NOT touch the inbox cards', async () => {
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const cc = `cc-${runId}`;
  const askId = newId() as ULID;
  seedRow(runId, cc, 'running'); // not paused → answer rejected pre-flip
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: cc,
    projectId,
    kind: 'orchestrator',
    promptBody: '?',
    now: 1_700_000_000_000,
  });
  registerStale(reg, runId, cc, 'paused');

  let touched = 0;
  const result = await answerPendingAsk(
    { pendingAskId: askId, answer: 'x', answeredBy: 'user' },
    {
      slug,
      registry: reg,
      askInbox: {
        collectUnactionedRecipients: () => {
          touched += 1;
          return [];
        },
        actionRecipients: () => 0,
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(touched, 0);
});

test('M4b — cancelPendingAsk actions the ask\'s open inbox cards too', async () => {
  const { cancelPendingAsk } = await import('../src/services/pause-resume.ts');
  const reg = new ActiveRunRegistry();
  const runId = newId() as ULID;
  const cc = `cc-${runId}`;
  const askId = newId() as ULID;
  seedRow(runId, cc, 'paused');
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId: cc,
    projectId,
    kind: 'orchestrator',
    promptBody: '?',
    now: 1_700_000_000_000,
  });
  registerStale(reg, runId, cc, 'paused');

  const collected: [string, string][] = [];
  const actioned: string[][] = [];
  const result = cancelPendingAsk(
    { pendingAskId: askId },
    {
      registry: reg,
      askInbox: {
        collectUnactionedRecipients: (kind, id) => {
          collected.push([kind, id]);
          return ['rec-9' as ULID];
        },
        actionRecipients: (ids) => {
          actioned.push([...ids]);
          return ids.length;
        },
      },
    },
  );
  assert.ok(result.ok);
  assert.equal(getPendingAsk(askId)!.status, 'cancelled');
  assert.deepEqual(collected, [['agent', askId]]);
  assert.deepEqual(actioned, [['rec-9']]);
});
