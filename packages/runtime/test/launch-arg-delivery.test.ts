// pc-pty-chat-455 #2 — launch-arg delivery of a dispatched worker's first turn.
//
// Fresh workers receive their prompt as claude's positional [prompt] arg so
// claude submits it itself after MCP connects — no post-ready paste/echo-ack
// (the spawn-failed/send-failed surface). Orchestrator (empty initialInput) and
// resume are excluded. These pin both halves: the arg builder appends the
// prompt, and AgentRun skips the post-ready send.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildLowLevelSpawnArgs, type LowLevelSpawnInput, type SpawnState } from '../src/low-level-spawn.ts';
import { AgentRun, type AgentRunInput, type SpawnLike } from '../src/agent-run.ts';
import { AgentRunRegistry } from '../src/agent-run-registry.ts';
import type { ReadyTimestamps } from '../src/ready-gate.ts';
import type { SendResult } from '../src/send-protocol.ts';

function baseInput(over: Partial<LowLevelSpawnInput> = {}): LowLevelSpawnInput {
  return {
    podDefinition: { name: 'researcher' },
    worktreePath: 'C:\\tmp\\wt',
    env: {},
    ccProviderSessionId: 'cc-1',
    mode: 'fresh',
    ...over,
  } as LowLevelSpawnInput;
}

// ── buildLowLevelSpawnArgs ─────────────────────────────────────────────────────

test('args: fresh + initialInputAtLaunch appends the prompt as the LAST positional arg', () => {
  const prompt = 'Investigate X and report.';
  const args = buildLowLevelSpawnArgs(baseInput({ initialInput: prompt, initialInputAtLaunch: true }), 'mcp.json');
  assert.equal(args[args.length - 1], prompt, 'prompt is the final arg');
  // It comes AFTER --session-id so commander reads it as the positional.
  const sidIdx = args.indexOf('--session-id');
  assert.ok(sidIdx >= 0 && args.indexOf(prompt) > sidIdx);
});

test('args: fresh + multi-line / long prompt preserved verbatim as one arg', () => {
  const prompt = 'line one\nline two with "quotes"\n' + 'x'.repeat(2000); // >800, multi-line
  const args = buildLowLevelSpawnArgs(baseInput({ initialInput: prompt, initialInputAtLaunch: true }), 'mcp.json');
  assert.equal(args[args.length - 1], prompt, 'no splitting/escaping — exact bytes');
  assert.equal(args.filter((a) => a === prompt).length, 1, 'appears exactly once');
});

test('args: fresh WITHOUT the launch flag does NOT append a positional (paste path)', () => {
  const args = buildLowLevelSpawnArgs(baseInput({ initialInput: 'do work', initialInputAtLaunch: false }), 'mcp.json');
  assert.ok(!args.includes('do work'), 'no positional prompt when flag is off');
});

test('args: resume never appends a positional even with the flag set', () => {
  const args = buildLowLevelSpawnArgs(
    baseInput({ mode: 'resume', initialInput: 'the answer', initialInputAtLaunch: true }),
    'mcp.json',
  );
  assert.ok(args.includes('--resume'));
  assert.ok(!args.includes('the answer'), 'resume continues the conversation; no launch prompt');
});

test('args: empty initialInput with the flag set appends nothing (orchestrator shape)', () => {
  const args = buildLowLevelSpawnArgs(baseInput({ initialInput: '', initialInputAtLaunch: true }), 'mcp.json');
  // last arg is the session id value, not an empty positional
  assert.notEqual(args[args.length - 1], '');
  assert.equal(args[args.length - 2], '--session-id');
});

// ── AgentRun: fresh worker skips the post-ready send ───────────────────────────

class FakeSpawn extends EventEmitter implements SpawnLike {
  sends: string[] = [];
  start(): void {}
  async awaitReady(): Promise<ReadyTimestamps> {
    return { spawnedAt: 1, bannerAt: 2, readyAt: 3 } as unknown as ReadyTimestamps;
  }
  async send(body: string): Promise<SendResult> {
    this.sends.push(body);
    return 'ok';
  }
  notifyMcpHandshake(): void {}
  interrupt(): void {}
  resize(): void {}
  kill(): void {}
  getState(): SpawnState {
    return 'running';
  }
  getJsonlPath(): string | null {
    return null;
  }
}

function makeRun(over: Partial<AgentRunInput> = {}): { run: AgentRun; spawn: FakeSpawn } {
  const spawn = new FakeSpawn();
  const run = new AgentRun(
    {
      agentRunId: 'run-1',
      ccProviderSessionId: 'cc-1',
      podDefinition: { name: 'researcher' },
      worktreePath: 'C:\\tmp\\wt',
      env: {},
      cancelGraceMs: 10,
      ...over,
    },
    { registry: new AgentRunRegistry({ maxConcurrent: 5 }), spawnFactory: () => spawn },
  );
  return { run, spawn };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function awaitState(run: AgentRun, state: string): Promise<void> {
  return new Promise((resolve) => {
    if (run.getState() === state) return resolve();
    const tick = () => {
      if (run.getState() === state) resolve();
      else setTimeout(tick, 2);
    };
    tick();
  });
}

test('AgentRun: fresh worker with initialInput does NOT paste — delivered at launch', async () => {
  const { run, spawn } = makeRun({ initialInput: 'do the work' });
  run.start();
  await awaitState(run, 'running');
  await sleep(10);
  assert.deepEqual(spawn.sends, [], 'no echo-ack send; prompt rode the launch arg');
  run.cancel();
  await sleep(30);
});
