import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupervisedChild, type ChildSpec, type ExitInfo } from '../src/supervised-child.ts';

// A minimal stand-in for a spawned process: an EventEmitter with kill() and a
// helper to simulate the OS reporting an exit.
class FakeChild extends EventEmitter {
  killed = false;
  killSignal: NodeJS.Signals | null = null;
  readonly stdout = null;
  readonly stderr = null;
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignal = signal ?? 'SIGTERM';
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

const SPEC: ChildSpec = {
  name: 'test-child',
  command: 'node',
  args: ['x.js'],
  cwd: '/tmp',
  env: {},
  stdio: 'ignore',
};

/** Build a SupervisedChild with a fake spawn, a manual clock, and instant delay. */
function harness(policy?: ConstructorParameters<typeof SupervisedChild>[0]['policy']) {
  const spawned: FakeChild[] = [];
  const giveUps: ExitInfo[] = [];
  let clock = 0;

  const child = new SupervisedChild({
    spec: SPEC,
    policy,
    deps: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawn: ((..._args: unknown[]) => {
        const c = new FakeChild();
        spawned.push(c);
        return c;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      now: () => clock,
      delay: () => Promise.resolve(),
    },
    hooks: { onGiveUp: (info) => giveUps.push(info) },
  });

  return {
    child,
    spawned,
    giveUps,
    latest: () => spawned[spawned.length - 1],
    setClock: (v: number) => {
      clock = v;
    },
  };
}

/** Let queued microtasks (the respawn .then chain) settle. */
const tick = () => new Promise((r) => setImmediate(r));

test('a rapid crash respawns with backoff; exceeding the budget gives up', async () => {
  const h = harness({ maxCrashRestarts: 3, healthyUptimeMs: 30_000 });
  await h.child.start();
  assert.equal(h.spawned.length, 1, 'spawned once on start');

  // Four rapid crashes (uptime ~0 < healthy). Crashes 1-3 respawn; the 4th
  // exceeds maxCrashRestarts and gives up.
  for (let i = 0; i < 4; i += 1) {
    h.latest().exit(1);
    await tick();
  }

  assert.equal(h.spawned.length, 4, 'initial + 3 respawns, then no more');
  assert.equal(h.child.hasGivenUp, true, 'gave up after the 4th rapid crash');
  assert.equal(h.giveUps.length, 1, 'onGiveUp fired exactly once');

  // A crash after giving up must not respawn.
  h.spawned[3].exit(1);
  await tick();
  assert.equal(h.spawned.length, 4, 'no respawn after give-up');
});

test('a healthy run resets the crash budget so it never gives up', async () => {
  const h = harness({ maxCrashRestarts: 3, healthyUptimeMs: 30_000 });
  await h.child.start();

  // Six crashes, but each child runs "healthy" (uptime >= 30s) before dying.
  // Without the reset this would give up after 4; with it, never.
  for (let i = 0; i < 6; i += 1) {
    h.setClock((i + 1) * 100_000); // each exit is long after its spawn
    h.latest().exit(1);
    await tick();
  }

  assert.equal(h.child.hasGivenUp, false, 'healthy resets keep it alive');
  assert.equal(h.giveUps.length, 0, 'never gave up');
  assert.equal(h.spawned.length, 7, 'initial + 6 respawns');
});

test('the sentinel restart code never counts as a crash and never gives up', async () => {
  const h = harness({ maxCrashRestarts: 3, sentinelRestartCode: 75 });
  await h.child.start();

  // Ten rapid sentinel exits — far past maxCrashRestarts. All must respawn.
  for (let i = 0; i < 10; i += 1) {
    h.latest().exit(75);
    await tick();
  }

  assert.equal(h.child.hasGivenUp, false, 'sentinel exits never give up');
  assert.equal(h.giveUps.length, 0);
  assert.equal(h.spawned.length, 11, 'initial + 10 sentinel respawns');
});

test('a graceful stop suppresses respawn', async () => {
  const h = harness();
  await h.child.start();

  h.child.stop('SIGINT');
  assert.equal(h.latest().killed, true, 'signalled the child');

  h.latest().exit(0, 'SIGINT');
  await tick();

  assert.equal(h.spawned.length, 1, 'no respawn after a graceful stop');
  assert.equal(h.giveUps.length, 0, 'a graceful stop is not a give-up');
});

test('preSpawn runs before every spawn (including respawns)', async () => {
  const calls: string[] = [];
  let clock = 0;
  const spawned: FakeChild[] = [];
  const child = new SupervisedChild({
    spec: SPEC,
    policy: { maxCrashRestarts: 3 },
    deps: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawn: (() => {
        const c = new FakeChild();
        spawned.push(c);
        calls.push('spawn');
        return c;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      now: () => clock,
      delay: () => Promise.resolve(),
    },
    hooks: {
      preSpawn: async () => {
        calls.push('pre');
      },
    },
  });

  await child.start();
  clock = 10;
  spawned[spawned.length - 1].exit(1);
  await tick();

  assert.deepEqual(calls, ['pre', 'spawn', 'pre', 'spawn'], 'preSpawn precedes each spawn');
});
