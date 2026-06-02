import { test } from 'node:test';
import assert from 'node:assert/strict';

const { classifyThrow, isTransient, withTransientRetry } = await import(
  '../src/services/failure-policy.ts'
);

const noSleep = async (): Promise<void> => {};

test('classifyThrow taxonomy', () => {
  assert.deepEqual(classifyThrow(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' })), {
    kind: 'transient',
    reason: 'db-busy',
  });
  assert.deepEqual(classifyThrow(new Error('database is SQLITE_LOCKED')), {
    kind: 'transient',
    reason: 'db-busy',
  });
  assert.deepEqual(classifyThrow(Object.assign(new Error('aborted'), { name: 'AbortError' })), {
    kind: 'transient',
    reason: 'host-blip',
  });
  assert.deepEqual(classifyThrow(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), {
    kind: 'transient',
    reason: 'network',
  });
  assert.deepEqual(classifyThrow(new Error('socket hang up')), {
    kind: 'transient',
    reason: 'network',
  });
  assert.deepEqual(classifyThrow(new Error('bad request')), {
    kind: 'terminal',
    reason: 'terminal',
  });
  assert.equal(isTransient(new Error('boom')), false);
});

test('withTransientRetry retries transient throws then succeeds', async () => {
  let calls = 0;
  const result = await withTransientRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      return 'ok';
    },
    { attempts: 5, sleep: noSleep },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withTransientRetry propagates a terminal throw immediately', async () => {
  let calls = 0;
  await assert.rejects(
    withTransientRetry(
      async () => {
        calls += 1;
        throw new Error('terminal boom');
      },
      { attempts: 5, sleep: noSleep },
    ),
    /terminal boom/,
  );
  assert.equal(calls, 1);
});

test('withTransientRetry gives up after the attempt budget', async () => {
  let calls = 0;
  await assert.rejects(
    withTransientRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error('still busy'), { code: 'SQLITE_BUSY' });
      },
      { attempts: 3, sleep: noSleep },
    ),
    /still busy/,
  );
  assert.equal(calls, 3);
});
