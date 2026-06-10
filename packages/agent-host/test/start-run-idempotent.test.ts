// Spawn-flakiness fix (2026-06-10) — the server's HostConnection re-sends a
// command ONCE when the first response times out. A re-sent start-run used to
// hit the duplicate guard ('run-exists'), so the dispatch was marked failed
// while the first send's run kept running as an untracked ghost. The host now
// answers a same-dispatch duplicate (same runId + ccSessionId) with an
// idempotent ok + live snapshot; genuine collisions still error.

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

function makeService(): AgentHostService {
  return new AgentHostService({
    spawnFactory: () => new FakeSpawn(),
    evictionSweepIntervalMs: 0,
  });
}

/** Drive the live run terminal so its lifecycle timers release the event loop
 *  (a still-running AgentRun keeps the test process alive forever). */
async function completeRun(service: AgentHostService, runId: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 10)); // lifecycle reaches running
  await service.handleCommand({ type: 'complete-run', runId: runId as never, result: '' });
}

test('duplicate start-run (same runId + ccSessionId) returns ok with the live snapshot, no second run', async () => {
  const service = makeService();
  const first = await service.handleCommand({
    type: 'start-run',
    request: startRequest(),
  });
  assert.equal(first.ok, true);
  await new Promise((r) => setTimeout(r, 10)); // lifecycle settles

  const retry = await service.handleCommand({
    type: 'start-run',
    request: startRequest(),
  });
  assert.equal(retry.ok, true, 'retry must be an idempotent ok, not run-exists');
  if (!retry.ok || retry.command !== 'start-run') assert.fail('expected start-run ok');
  assert.equal(retry.run.runId, '01RUN');
  assert.equal(retry.run.ccSessionId, 'cc-1');

  const list = await service.handleCommand({ type: 'list-runs' });
  if (!list.ok || list.command !== 'list-runs') assert.fail('expected list-runs ok');
  assert.equal(list.runs.length, 1, 'duplicate must not register a second run');
  await completeRun(service, '01RUN');
});

test('same runId from a DIFFERENT dispatch (ccSessionId mismatch) still errors run-exists', async () => {
  const service = makeService();
  const first = await service.handleCommand({
    type: 'start-run',
    request: startRequest(),
  });
  assert.equal(first.ok, true);

  const collision = await service.handleCommand({
    type: 'start-run',
    request: startRequest({ ccSessionId: 'cc-other' }),
  });
  assert.equal(collision.ok, false);
  if (collision.ok) assert.fail('expected error');
  assert.equal(collision.code, 'run-exists');
  await completeRun(service, '01RUN');
});

test('new runId on an occupied ccSessionId still errors run-exists', async () => {
  const service = makeService();
  const first = await service.handleCommand({
    type: 'start-run',
    request: startRequest(),
  });
  assert.equal(first.ok, true);

  const collision = await service.handleCommand({
    type: 'start-run',
    request: startRequest({ runId: '01RUN2' as never }),
  });
  assert.equal(collision.ok, false);
  if (collision.ok) assert.fail('expected error');
  assert.equal(collision.code, 'run-exists');
  await completeRun(service, '01RUN');
});

test('run snapshots carry a pid field (null for spawns that expose none)', async () => {
  const service = makeService();
  const started = await service.handleCommand({
    type: 'start-run',
    request: startRequest(),
  });
  if (!started.ok || started.command !== 'start-run') assert.fail('expected start-run ok');
  assert.equal('pid' in started.run, true, 'snapshot must carry pid');
  assert.equal(started.run.pid, null);
  await completeRun(service, '01RUN');
});
