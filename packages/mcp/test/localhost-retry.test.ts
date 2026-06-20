import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTransientConnError, withConnRetry } from '../src/tools/retry.ts';

const noSleep = async (): Promise<void> => {};

test('isTransientConnError detects connection codes + messages', () => {
  assert.equal(isTransientConnError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), true);
  assert.equal(isTransientConnError(new Error('socket hang up')), true);
  assert.equal(isTransientConnError(new Error('bad json')), false);
  assert.equal(isTransientConnError(Object.assign(new Error('x'), { code: 'EBADF' })), false);
});

test('withConnRetry retries ECONNREFUSED then resolves', async () => {
  let calls = 0;
  const result = await withConnRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      return { status: 200, body: 'ok' };
    },
    { attempts: 5, sleep: noSleep },
  );
  assert.deepEqual(result, { status: 200, body: 'ok' });
  assert.equal(calls, 3);
});

test('withConnRetry retries a 503 with Retry-After then resolves', async () => {
  let calls = 0;
  const result = await withConnRetry(
    async () => {
      calls += 1;
      return calls < 2
        ? { status: 503, body: '', retryAfter: '1' }
        : { status: 200, body: 'ok', retryAfter: null };
    },
    { attempts: 5, sleep: noSleep },
  );
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

test('withConnRetry returns a bare 503 (no Retry-After) without retrying', async () => {
  let calls = 0;
  const result = await withConnRetry(
    async () => {
      calls += 1;
      return { status: 503, body: 'conflict', retryAfter: null };
    },
    { attempts: 5, sleep: noSleep },
  );
  assert.equal(result.status, 503);
  assert.equal(calls, 1, 'bare 503 must not be retried');
});

test('withConnRetry returns a non-503 error response without retrying', async () => {
  let calls = 0;
  const result = await withConnRetry(
    async () => {
      calls += 1;
      return { status: 404, body: 'not found' };
    },
    { attempts: 5, sleep: noSleep },
  );
  assert.equal(result.status, 404);
  assert.equal(calls, 1);
});

test('withConnRetry gives up after the attempt budget on a persistent refusal', async () => {
  let calls = 0;
  await assert.rejects(
    withConnRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      },
      { attempts: 3, sleep: noSleep },
    ),
    /refused/,
  );
  assert.equal(calls, 3);
});

test('withConnRetry propagates a non-transient throw immediately', async () => {
  let calls = 0;
  await assert.rejects(
    withConnRetry(
      async () => {
        calls += 1;
        throw new Error('parse blew up');
      },
      { attempts: 5, sleep: noSleep },
    ),
    /parse blew up/,
  );
  assert.equal(calls, 1);
});
