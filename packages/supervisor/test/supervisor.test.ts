import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupervisedChild, type ChildSpec } from '../src/supervised-child.ts';
import { Supervisor } from '../src/supervisor.ts';

class FakeChild extends EventEmitter {
  killed = false;
  signals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = null;
  readonly stderr = null;
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.signals.push(signal ?? 'SIGTERM');
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function spec(name: string): ChildSpec {
  return { name, command: 'node', args: [], cwd: '/tmp', env: {}, stdio: 'ignore' };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Two supervised children (api + host) under one Supervisor, fully faked. */
function harness() {
  const spawned: Record<string, FakeChild[]> = { api: [], host: [] };
  const makeChild = (name: 'api' | 'host'): SupervisedChild =>
    new SupervisedChild({
      spec: spec(name),
      deps: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        spawn: (() => {
          const c = new FakeChild();
          spawned[name].push(c);
          return c;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
        now: () => 0,
        delay: () => Promise.resolve(),
      },
    });

  const host = makeChild('host');
  const api = makeChild('api');
  const supervisor = new Supervisor({ children: [host, api] });
  const latest = (name: 'api' | 'host'): FakeChild => {
    const list = spawned[name];
    return list[list.length - 1];
  };
  return { supervisor, host, api, spawned, latest };
}

test('an API child exit triggers a backoff respawn (not a log line)', async () => {
  const h = harness();
  await h.supervisor.start();
  assert.equal(h.spawned.api.length, 1);

  h.latest('api').exit(1);
  await tick();

  assert.equal(h.spawned.api.length, 2, 'API child respawned');
  assert.equal(h.spawned.host.length, 1, 'host untouched');
});

test('a host child exit triggers a backoff respawn (not a log line)', async () => {
  const h = harness();
  await h.supervisor.start();

  h.latest('host').exit(1);
  await tick();

  assert.equal(h.spawned.host.length, 2, 'host child respawned');
  assert.equal(h.spawned.api.length, 1, 'API untouched');
});

test('a graceful stop suppresses respawn for every child', async () => {
  const h = harness();
  await h.supervisor.start();

  h.supervisor.stopAll('SIGINT');
  assert.deepEqual(h.latest('api').signals, ['SIGINT']);
  assert.deepEqual(h.latest('host').signals, ['SIGINT']);

  h.latest('api').exit(0, 'SIGINT');
  h.latest('host').exit(0, 'SIGINT');
  await tick();

  assert.equal(h.spawned.api.length, 1, 'no API respawn after stop');
  assert.equal(h.spawned.host.length, 1, 'no host respawn after stop');
});

test('stopAndWait resolves true when children exit before the deadline', async () => {
  const h = harness();
  await h.supervisor.start();

  const done = h.supervisor.stopAndWait('SIGINT', 1_000);
  h.latest('api').exit(0, 'SIGINT');
  h.latest('host').exit(0, 'SIGINT');

  assert.equal(await done, true, 'all children exited gracefully');
});

test('stopAndWait escalates to SIGKILL on a child that misses the deadline', async () => {
  const h = harness();
  await h.supervisor.start();

  const done = h.supervisor.stopAndWait('SIGINT', 20);
  h.latest('host').exit(0, 'SIGINT'); // host obeys; api hangs

  assert.equal(await done, false, 'reported the missed deadline');
  assert.ok(h.latest('api').signals.includes('SIGKILL'), 'hanging child got SIGKILL');
  assert.ok(!h.latest('host').signals.includes('SIGKILL'), 'obedient child did not');
});
