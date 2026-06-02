import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isTransient } = await import('../src/services/failure-policy.ts');

test('isTransient classifies infra throws', () => {
  // db contention
  assert.equal(
    isTransient(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' })),
    true,
  );
  assert.equal(isTransient(new Error('database is SQLITE_LOCKED')), true);
  // aborted / timed-out in-flight call
  assert.equal(
    isTransient(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    true,
  );
  // connection-level failures
  assert.equal(
    isTransient(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })),
    true,
  );
  assert.equal(isTransient(new Error('socket hang up')), true);
  // terminal
  assert.equal(isTransient(new Error('bad request')), false);
  assert.equal(isTransient(new Error('boom')), false);
});
