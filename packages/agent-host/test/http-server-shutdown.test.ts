// The shutdown-never-exits bug (found live 2026-06-03): a persistent /events
// stream kept `server.close()` waiting forever, so `shutdown host-exit` was a
// silent no-op — the process stayed alive and the lock file stayed. These
// tests pin the fix: close destroys live sockets and resolves within a
// deadline, with the open stream still attached.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, request } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { startHttpAgentHostServer } from '../src/http-server.ts';

/** Open the persistent /events ndjson stream and keep it open (never consume
 *  to completion) — the exact connection that hung the live shutdown. */
function openEventsStream(port: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = get(`http://127.0.0.1:${port}/events`, (res) => {
      res.on('data', () => {});
      res.on('error', () => {}); // socket destroyed by shutdown — expected
      resolve(res);
    });
    req.on('error', reject);
  });
}

function postShutdownHostExit(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/command',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (b) => {
          body += b;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ command: { type: 'shutdown', mode: 'host-exit' } }));
  });
}

test('shutdown host-exit completes despite an open /events stream (and removes the lock)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-host-shutdown-'));
  const lockFilePath = join(dir, 'host.lock.json');
  const host = await startHttpAgentHostServer({ lockFilePath, closeDeadlineMs: 5_000 });

  try {
    assert.equal(existsSync(lockFilePath), true, 'lock published on boot');
    await openEventsStream(host.port);

    const started = Date.now();
    const response = await postShutdownHostExit(host.port);
    assert.equal(response.status, 200);
    assert.match(response.body, /"ok":\s*true/, 'caller received its ok before teardown');

    // THE assertion: closed resolves — pre-fix this hung forever.
    await host.closed;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `closed within the deadline (took ${elapsed}ms)`);
    assert.equal(existsSync(lockFilePath), false, 'lock file removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('close() resolves despite an open /events stream', async () => {
  const host = await startHttpAgentHostServer({ closeDeadlineMs: 5_000 });
  await openEventsStream(host.port);

  const started = Date.now();
  await host.close();
  assert.ok(Date.now() - started < 5_000, 'close resolved');
});

test('close() is idempotent and closed mirrors it', async () => {
  const host = await startHttpAgentHostServer({});
  await Promise.all([host.close(), host.close()]);
  await host.closed;
});
