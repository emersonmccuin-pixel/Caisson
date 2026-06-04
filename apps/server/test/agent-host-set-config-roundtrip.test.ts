// FD-15 regression — the set-config push must round-trip end to end: real
// HTTP host server ← real HttpAgentHostClient. Found live 2026-06-04 (Step 7
// cutover): the client's response validator had no `set-config` case, so the
// host APPLIED the cap but the server rejected the receipt as "malformed
// response" — the push looked failed on every connect. Host-side unit tests
// (packages/agent-host) and the /health check both passed, masking it; only a
// client↔server round-trip catches this class.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHttpAgentHostServer } from '@pc/agent-host';
import { HttpAgentHostClient } from '../src/services/agent-host-client.ts';

test('set-config round-trips: ok receipt with the effective cap', async () => {
  const host = await startHttpAgentHostServer({});
  const client = new HttpAgentHostClient(`http://127.0.0.1:${host.port}`);
  try {
    const response = await client.sendCommand({ type: 'set-config', maxConcurrent: 7 });
    assert.equal(response.ok, true, `push receipt rejected: ${JSON.stringify(response)}`);
    if (!response.ok || response.command !== 'set-config') {
      assert.fail('expected an ok set-config response');
    }
    assert.equal(response.maxConcurrent, 7, 'receipt carries the effective cap');
  } finally {
    client.close?.();
    await host.close();
  }
});

test('set-config round-trips the clamped value as the receipt', async () => {
  const host = await startHttpAgentHostServer({});
  const client = new HttpAgentHostClient(`http://127.0.0.1:${host.port}`);
  try {
    const response = await client.sendCommand({ type: 'set-config', maxConcurrent: 999 });
    if (!response.ok || response.command !== 'set-config') {
      assert.fail('expected an ok set-config response');
    }
    assert.equal(response.maxConcurrent, 50, 'clamped to the ceiling');
  } finally {
    client.close?.();
    await host.close();
  }
});
