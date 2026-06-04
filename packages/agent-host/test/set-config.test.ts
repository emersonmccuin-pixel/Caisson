// FD-15 — `set-config` host command applies the concurrency cap live.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentHostService } from '../src/agent-host-service.ts';

test('set-config updates the cap and returns the effective value', async () => {
  const service = new AgentHostService({ maxConcurrent: 5 });

  const res = await service.handleCommand({ type: 'set-config', maxConcurrent: 12 });
  assert.equal(res.ok, true);
  if (!res.ok || res.command !== 'set-config') assert.fail('expected set-config response');
  assert.equal(res.maxConcurrent, 12);
});

test('set-config clamps out-of-band values', async () => {
  const service = new AgentHostService();

  const low = await service.handleCommand({ type: 'set-config', maxConcurrent: 0 });
  if (!low.ok || low.command !== 'set-config') assert.fail('expected set-config response');
  assert.equal(low.maxConcurrent, 1);

  const high = await service.handleCommand({ type: 'set-config', maxConcurrent: 999 });
  if (!high.ok || high.command !== 'set-config') assert.fail('expected set-config response');
  assert.equal(high.maxConcurrent, 50);
});
