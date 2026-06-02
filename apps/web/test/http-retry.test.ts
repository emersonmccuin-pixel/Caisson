// T2.1 — getJson/postJson retry across the API-restart window.
//   * 503 → retry (any method; honors Retry-After) then succeed.
//   * thrown network error → retry GET only; posts fail fast (no double-submit).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getJson, postJson } from '../src/api/http.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('getJson retries a 503 (Retry-After:0) then returns the 200 body', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls < 2
      ? jsonResponse(503, { ok: false }, { 'Retry-After': '0' })
      : jsonResponse(200, { value: 42 });
  }) as typeof fetch;

  const result = await getJson<{ value: number }>('/api/thing');
  assert.equal(result.value, 42);
  assert.equal(calls, 2);
});

test('getJson retries a thrown network error then succeeds', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls < 2) throw new TypeError('fetch failed');
    return jsonResponse(200, { value: 7 });
  }) as typeof fetch;

  const result = await getJson<{ value: number }>('/api/thing');
  assert.equal(result.value, 7);
  assert.equal(calls, 2);
});

test('getJson gives up and throws after the attempt budget', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  }) as typeof fetch;

  await assert.rejects(getJson('/api/thing'), /fetch failed/);
  assert.equal(calls, 4);
});

test('postJson retries a 503 then succeeds', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls < 2
      ? jsonResponse(503, { ok: false }, { 'Retry-After': '0' })
      : jsonResponse(200, { ok: true, id: 'x' });
  }) as typeof fetch;

  const result = await postJson<{ ok: true; id: string }>('/api/thing', { a: 1 });
  assert.equal(result.id, 'x');
  assert.equal(calls, 2);
});

test('postJson does NOT retry a thrown network error (no double-submit)', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  }) as typeof fetch;

  await assert.rejects(postJson('/api/thing', { a: 1 }), /fetch failed/);
  assert.equal(calls, 1);
});
