import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForFreshFile, waitForPortsFree } from '../src/waits.ts';

/** Manual clock: now() reads a counter; delay() advances it. */
function fakeClock(stepMs = 100) {
  let t = 0;
  return {
    now: () => t,
    delay: (ms: number): Promise<void> => {
      t += Math.max(ms, stepMs);
      return Promise.resolve();
    },
  };
}

test('waitForPortsFree resolves once every port frees up', async () => {
  const deps = fakeClock();
  let probes = 0;
  const ok = await waitForPortsFree([4040], {
    timeoutMs: 5_000,
    probeIntervalMs: 100,
    deps,
    portInUseImpl: () => Promise.resolve(++probes < 3), // busy twice, then free
  });
  assert.equal(ok, true);
  assert.equal(probes, 3);
});

test('waitForPortsFree times out while a port stays busy', async () => {
  const deps = fakeClock();
  const ok = await waitForPortsFree([4040], {
    timeoutMs: 1_000,
    probeIntervalMs: 100,
    deps,
    portInUseImpl: () => Promise.resolve(true),
  });
  assert.equal(ok, false);
});

test('waitForPortsFree aborts early on shouldAbort', async () => {
  const deps = fakeClock();
  let probes = 0;
  const ok = await waitForPortsFree([4040], {
    timeoutMs: 60_000,
    deps,
    shouldAbort: () => probes >= 2,
    portInUseImpl: () => Promise.resolve(++probes > 0),
  });
  assert.equal(ok, false, 'abort = not-free (caller decides)');
  assert.ok(probes <= 3, 'stopped probing after abort');
});

test('waitForFreshFile rejects a stale file and accepts a fresh one', async () => {
  const deps = fakeClock();
  let mtime = 50; // stale: before notBefore
  const ok = await waitForFreshFile('/tmp/host.lock.json', {
    notBefore: 100,
    timeoutMs: 5_000,
    probeIntervalMs: 100,
    deps,
    statImpl: () => {
      const seen = mtime;
      mtime += 60; // the host rewrites the lock as it boots
      return { mtimeMs: seen };
    },
  });
  assert.equal(ok, true, 'fresh mtime accepted');
});

test('waitForFreshFile times out when the file never appears', async () => {
  const deps = fakeClock();
  const ok = await waitForFreshFile('/tmp/host.lock.json', {
    notBefore: 0,
    timeoutMs: 1_000,
    probeIntervalMs: 100,
    deps,
    statImpl: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(ok, false);
});
