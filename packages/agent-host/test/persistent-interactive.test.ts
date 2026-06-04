// Step-4 Slice 1 — host-service surface for the persistent-interactive
// policy: policy threading start-run → snapshot, interrupt/resize command
// routing (G2/G6), turn-state in the snapshot stream (G1), and replay meta
// (cursor/kind/source) on run-jsonl wire events (G7).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type {
  AgentHostEvent,
  AgentHostStartRunRequest,
  SpawnLike,
} from '@pc/runtime';
import { AgentHostService } from '../src/agent-host-service.ts';

class FakeSpawn extends EventEmitter implements SpawnLike {
  interrupts = 0;
  resizes: Array<{ cols: number; rows: number }> = [];
  rawWrites: string[] = [];

  start(): void {}
  writeRaw(bytes: string): boolean {
    this.rawWrites.push(bytes);
    return true;
  }
  async awaitReady(): Promise<never> {
    return { spawnedAt: 1, bannerAt: 2, readyAt: 3 } as never;
  }
  async send(): Promise<'ok'> {
    return 'ok';
  }
  notifyMcpHandshake(): void {}
  interrupt(): void {
    this.interrupts++;
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
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
    podDefinition: { name: 'orchestrator' },
    worktreePath: 'C:\\tmp\\wt',
    env: {},
    initialInput: '',
    ...overrides,
  };
}

async function startedService(): Promise<{
  service: AgentHostService;
  spawn: FakeSpawn;
  events: AgentHostEvent[];
}> {
  const spawn = new FakeSpawn();
  const service = new AgentHostService({ spawnFactory: () => spawn });
  const events: AgentHostEvent[] = [];
  service.on('event', (event: AgentHostEvent) => events.push(event));

  const res = await service.handleCommand({
    type: 'start-run',
    request: startRequest({ policy: 'persistent-interactive' }),
  });
  assert.equal(res.ok, true);
  // Let the async lifecycle reach running (awaitReady resolves immediately).
  await new Promise((r) => setTimeout(r, 10));
  return { service, spawn, events };
}

test('policy threads start-run → run → snapshot, with turn-state', async () => {
  const { service } = await startedService();
  const res = await service.handleCommand({ type: 'list-runs' });
  if (!res.ok || res.command !== 'list-runs') assert.fail('expected list-runs');
  assert.equal(res.runs.length, 1);
  assert.equal(res.runs[0]!.policy, 'persistent-interactive');
  assert.equal(res.runs[0]!.state, 'running');
  // Empty initialInput → composer at the prompt.
  assert.equal(res.runs[0]!.turnState, 'ready');
});

test('interrupt routes to the spawn and returns a snapshot', async () => {
  const { service, spawn } = await startedService();
  const res = await service.handleCommand({
    type: 'interrupt',
    runId: '01RUN' as never,
  });
  if (!res.ok || res.command !== 'interrupt') assert.fail('expected interrupt ok');
  assert.equal(spawn.interrupts, 1);
  assert.equal(res.run.runId, '01RUN');
});

test('resize routes cols/rows to the spawn', async () => {
  const { service, spawn } = await startedService();
  const res = await service.handleCommand({
    type: 'resize',
    runId: '01RUN' as never,
    cols: 132,
    rows: 43,
  });
  if (!res.ok || res.command !== 'resize') assert.fail('expected resize ok');
  assert.deepEqual(spawn.resizes, [{ cols: 132, rows: 43 }]);
});

test('write-raw routes raw bytes to the spawn', async () => {
  const { service, spawn } = await startedService();
  const res = await service.handleCommand({
    type: 'write-raw',
    runId: '01RUN' as never,
    data: '\x1b[B',
  });
  if (!res.ok || res.command !== 'write-raw') assert.fail('expected write-raw ok');
  assert.deepEqual(spawn.rawWrites, ['\x1b[B']);
});

test('interrupt/resize on unknown run → not-found', async () => {
  const { service } = await startedService();
  const res = await service.handleCommand({
    type: 'interrupt',
    runId: '01NOPE' as never,
  });
  assert.equal(res.ok, false);
  if (res.ok) assert.fail('expected error');
  assert.equal(res.code, 'not-found');
});

test('run-jsonl wire events carry replay meta (cursor/kind/source)', async () => {
  const { spawn, events } = await startedService();
  spawn.emit(
    'jsonl-event',
    { kind: 'jsonl-turn-end', text: 'hi', stopReason: 'end_turn', row: {} },
    { sourceCursor: 42 },
  );
  const jsonl = events.find((e) => e.type === 'run-jsonl');
  assert.ok(jsonl, 'expected a run-jsonl event');
  if (jsonl.type !== 'run-jsonl') assert.fail('narrow');
  assert.equal(jsonl.cursor, 42);
  assert.equal(jsonl.kind, 'jsonl-turn-end');
  assert.equal(jsonl.source, 'claude-jsonl');
});

test('turn-state changes emit fresh run-state snapshots', async () => {
  const { spawn, events } = await startedService();
  const before = events.filter((e) => e.type === 'run-state').length;

  // jsonl-user opens a turn → busy → snapshot refresh.
  spawn.emit('jsonl-event', { kind: 'jsonl-user', text: 'go', row: {} });
  const after = events.filter((e) => e.type === 'run-state');
  assert.ok(after.length > before, 'expected a new run-state event');
  const last = after[after.length - 1]!;
  if (last.type !== 'run-state') assert.fail('narrow');
  assert.equal(last.run.turnState, 'busy');
});
