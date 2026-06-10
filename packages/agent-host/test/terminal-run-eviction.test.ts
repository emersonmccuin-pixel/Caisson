// Audit #1 (2026-06-10) — terminal runs must eventually leave the in-memory
// `runs` map. Before this fix a long-lived host grew one HostRunEntry
// (+5 wired listeners) per dispatch forever. Eviction must respect the
// retention window (the server's missed-terminal replay reads terminal
// snapshots for hours after the fact) and must never touch live runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AgentHostStartRunRequest, SpawnLike } from '@pc/runtime';
import { AgentHostService } from '../src/agent-host-service.ts';

class FakeSpawn extends EventEmitter implements SpawnLike {
  start(): void {}
  writeRaw(): boolean {
    return true;
  }
  async awaitReady(): Promise<never> {
    return { spawnedAt: 1, bannerAt: 2, readyAt: 3 } as never;
  }
  async send(): Promise<'ok'> {
    return 'ok';
  }
  notifyMcpHandshake(): void {}
  interrupt(): void {}
  resize(): void {}
  kill(): void {}
  getState(): 'running' {
    return 'running';
  }
  getJsonlPath(): string | null {
    return null;
  }
}

function startRequest(
  overrides: Partial<AgentHostStartRunRequest> = {},
): AgentHostStartRunRequest {
  return {
    runId: '01RUN' as AgentHostStartRunRequest['runId'],
    projectId: '01PRJ' as AgentHostStartRunRequest['projectId'],
    dispatcherSessionId: 'disp-1',
    ccSessionId: 'cc-1',
    podDefinition: { name: 'worker' },
    worktreePath: 'C:\\tmp\\wt',
    env: {},
    initialInput: '',
    ...overrides,
  };
}

async function listRunCount(service: AgentHostService): Promise<number> {
  const res = await service.handleCommand({ type: 'list-runs' });
  if (!res.ok || res.command !== 'list-runs') assert.fail('expected list-runs ok');
  return res.runs.length;
}

test('terminal runs are evicted after the retention window; live runs are kept', async () => {
  let clock = 1_000_000;
  const service = new AgentHostService({
    spawnFactory: () => new FakeSpawn(),
    now: () => clock,
    terminalRunRetentionMs: 60_000,
    evictionSweepIntervalMs: 0, // test drives eviction directly
  });

  const started = await service.handleCommand({
    type: 'start-run',
    request: startRequest(),
  });
  assert.equal(started.ok, true);
  await new Promise((r) => setTimeout(r, 10)); // lifecycle reaches running

  // Live run: never evicted, regardless of age.
  clock += 3_600_000;
  assert.equal(service.evictStaleTerminalRuns(), 0);
  assert.equal(await listRunCount(service), 1);

  // Complete the run → terminal snapshot must SURVIVE inside the window.
  const completed = await service.handleCommand({
    type: 'complete-run',
    runId: '01RUN' as never,
    result: 'done',
  });
  assert.equal(completed.ok, true);
  clock += 30_000; // half the retention window
  assert.equal(service.evictStaleTerminalRuns(), 0);
  assert.equal(await listRunCount(service), 1, 'terminal snapshot kept within retention');

  // Past the window → evicted.
  clock += 31_000;
  assert.equal(service.evictStaleTerminalRuns(), 1);
  assert.equal(await listRunCount(service), 0, 'terminal run evicted after retention');
});
