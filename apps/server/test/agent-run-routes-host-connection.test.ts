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

const { closeDb, createProject, runMigrations } = await import('@pc/db');
const { registerAgentRunRoutes } = await import('../src/features/agent-runs/routes.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const fakeChannelServer = {} as never;

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
    channelServer: fakeChannelServer,
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
