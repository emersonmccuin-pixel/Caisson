// T1.1 — the by-value→closure fix. Routes must resolve the host client PER
// REQUEST via getHostConnection so a host respawn/swap is seen with no API
// restart. Flip the resolved connection between two dispatches and assert the
// second request's dispatchFreshAgent received the NEW client.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-arr-host-conn-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject,
  insertAgentRunRow,
  getAgentRunRow,
  newId,
  runMigrations,
  updateAgentRunPid,
} = await import('@pc/db');
const { registerAgentRunRoutes } = await import('../src/features/agent-runs/routes.ts');

type SentCommand = { type: string; runId?: string; pcSessionId?: string };

/** A minimal fake HostConnection capturing the commands the routes issue. */
function fakeHost(commands: SentCommand[], opts: { throwOnSend?: boolean } = {}) {
  return {
    listRuns: () => [],
    sendCommand: async (cmd: SentCommand) => {
      commands.push(cmd);
      if (opts.throwOnSend) throw new Error('host send failed');
      return { ok: true } as never;
    },
  } as never;
}

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('invoke resolves the host connection PER REQUEST (closure, not by-value)', async () => {
  const project = createProject({
    slug: `arr-hc-${Date.now()}`,
    name: 'ARR HC',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: join(tmpDir, 'arr-hc'),
  });

  const clientA = { tag: 'A', listRuns: () => [], sendCommand: async () => undefined } as never;
  const clientB = { tag: 'B', listRuns: () => [], sendCommand: async () => undefined } as never;
  let current: typeof clientA | typeof clientB | null = clientA;

  const seen: Array<unknown> = [];
  const app = new Hono();
  registerAgentRunRoutes(app, {
    broadcastTo: () => {},
    getHostConnection: () => current,
    getActiveRunRegistry: () => ({ get: () => null }),
    dispatchFreshAgent: (async (_args: unknown, deps: { hostClient?: unknown }) => {
      seen.push(deps.hostClient);
      return { ok: true, agentRunId: 'r1', ccSessionId: 'cc-1' };
    }) as never,
  });

  const body = JSON.stringify({ input: 'go', dispatcherSessionId: 'disp1' });
  const headers = { 'content-type': 'application/json' };

  await app.request(`/api/projects/${project.id}/agents/builder/invoke`, {
    method: 'POST',
    headers,
    body,
  });
  // swap the live connection (host respawn) — NO re-registration
  current = clientB;
  await app.request(`/api/projects/${project.id}/agents/builder/invoke`, {
    method: 'POST',
    headers,
    body,
  });

  assert.equal((seen[0] as { tag: string }).tag, 'A');
  assert.equal((seen[1] as { tag: string }).tag, 'B', 'second request must see the swapped client');
});

// ── T1.3 host-aware kill / cancel ────────────────────────────────────────────

test('T1.3 /kill on a host-backed run (pid null) sends host cancel + finalizes cancelled', async () => {
  const project = createProject({
    slug: `arr-kill-${Date.now()}`,
    name: 'ARR Kill',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: join(tmpDir, 'arr-kill'),
  });
  const runId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'builder',
    dispatcherSessionId: 'disp-host',
    ccSessionId: `cc-${runId}`,
    status: 'running',
    input: 'go',
    queuedAt: Date.now(),
  });

  const commands: SentCommand[] = [];
  const app = new Hono();
  registerAgentRunRoutes(app, {
    broadcastTo: () => {},
    getHostConnection: () => fakeHost(commands),
    getActiveRunRegistry: () => ({ get: () => null }),
  });

  const res = await app.request(`/api/projects/${project.id}/agent-runs/${runId}/kill`, {
    method: 'POST',
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; hostCancelled: boolean; processKilled: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.hostCancelled, true, 'host cancel acked → reported (not misleading processKilled-only)');
  assert.equal(body.processKilled, false, 'host run has null pid → no local kill');
  assert.deepEqual(commands, [{ type: 'cancel', runId }]);
  assert.equal(getAgentRunRow(runId)?.status, 'cancelled', 'row force-finalized');
});

test('T1.3 /cancel on a host-backed run NOT in the registry sends host cancel + ok (no 404)', async () => {
  const project = createProject({
    slug: `arr-cancel-${Date.now()}`,
    name: 'ARR Cancel',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: join(tmpDir, 'arr-cancel'),
  });
  const runId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'builder',
    dispatcherSessionId: 'disp-host',
    ccSessionId: `cc-${runId}`,
    status: 'running',
    input: 'go',
    queuedAt: Date.now(),
  });

  const commands: SentCommand[] = [];
  const app = new Hono();
  registerAgentRunRoutes(app, {
    broadcastTo: () => {},
    getHostConnection: () => fakeHost(commands),
    getActiveRunRegistry: () => ({ get: () => null }),
  });

  const res = await app.request(`/api/projects/${project.id}/agent-runs/${runId}/cancel`, {
    method: 'POST',
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; hostCancelled: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.hostCancelled, true);
  assert.deepEqual(commands, [{ type: 'cancel', runId }]);
  // Distinct from /kill: /cancel does NOT force-finalize — host terminal event does.
  assert.equal(getAgentRunRow(runId)?.status, 'running', 'cancel leaves the row for the host terminal event');
});

test('T1.3 /cancel on a workflow-dispatched run (wf- dispatcher) sends a plain cancel by runId (door unified)', async () => {
  // Post door-unification, a workflow agent run is a normal host run keyed by
  // runId — the `wf-` dispatcher no longer routes to `cancel-workflow-subagent`.
  const project = createProject({
    slug: `arr-wf-${Date.now()}`,
    name: 'ARR WF',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: join(tmpDir, 'arr-wf'),
  });
  const runId = newId();
  const pcSessionId = `wf-abcdef12-node1-12345678`;
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'builder',
    dispatcherSessionId: pcSessionId,
    ccSessionId: `cc-${runId}`,
    status: 'running',
    input: 'go',
    queuedAt: Date.now(),
  });

  const commands: SentCommand[] = [];
  const app = new Hono();
  registerAgentRunRoutes(app, {
    broadcastTo: () => {},
    getHostConnection: () => fakeHost(commands),
    getActiveRunRegistry: () => ({ get: () => null }),
  });

  const res = await app.request(`/api/projects/${project.id}/agent-runs/${runId}/cancel`, {
    method: 'POST',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(commands, [{ type: 'cancel', runId }]);
});

test('T1.3 /cancel on a genuinely unknown run → 404', async () => {
  const project = createProject({
    slug: `arr-unknown-${Date.now()}`,
    name: 'ARR Unknown',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: join(tmpDir, 'arr-unknown'),
  });
  const commands: SentCommand[] = [];
  const app = new Hono();
  registerAgentRunRoutes(app, {
    broadcastTo: () => {},
    getHostConnection: () => fakeHost(commands),
    getActiveRunRegistry: () => ({ get: () => null }),
  });

  const res = await app.request(`/api/projects/${project.id}/agent-runs/${newId()}/cancel`, {
    method: 'POST',
  });
  assert.equal(res.status, 404);
  assert.deepEqual(commands, [], 'no host command for an unknown run');
});

test('T1.3 /cancel on an in-process registered run → registry cancel(), no host command', async () => {
  const project = createProject({
    slug: `arr-inproc-${Date.now()}`,
    name: 'ARR InProc',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: join(tmpDir, 'arr-inproc'),
  });
  const runId = newId();
  // In-process run: registered handle + persisted pid (NOT host-backed).
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'builder',
    dispatcherSessionId: 'disp-inproc',
    ccSessionId: `cc-${runId}`,
    status: 'running',
    input: 'go',
    queuedAt: Date.now(),
  });
  updateAgentRunPid(runId, 999999); // non-null pid ⇒ in-process ⇒ no host command

  let cancelled = false;
  const commands: SentCommand[] = [];
  const app = new Hono();
  registerAgentRunRoutes(app, {
    broadcastTo: () => {},
    getHostConnection: () => fakeHost(commands),
    getActiveRunRegistry: () => ({
      get: (id: string) =>
        id === runId
          ? { projectId: project.id, run: { cancel: () => (cancelled = true) } }
          : null,
    }),
  });

  const res = await app.request(`/api/projects/${project.id}/agent-runs/${runId}/cancel`, {
    method: 'POST',
  });
  assert.equal(res.status, 200);
  assert.equal(cancelled, true, 'registry handle cancel() drove the teardown');
  assert.deepEqual(commands, [], 'in-process run (non-null pid) issues NO host command');
});
