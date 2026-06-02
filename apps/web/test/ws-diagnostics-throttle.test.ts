import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldPublishInboundDiagnostics } from '../src/hooks/use-project-ws.ts';

test('inbound diagnostics publish the first frame immediately', () => {
  assert.equal(shouldPublishInboundDiagnostics(0, 1_000, 'jsonl'), true);
});

test('inbound diagnostics throttle high-frequency non-heartbeat frames', () => {
  assert.equal(shouldPublishInboundDiagnostics(1_000, 1_100, 'raw'), false);
  assert.equal(shouldPublishInboundDiagnostics(1_000, 1_249, 'jsonl'), false);
  assert.equal(shouldPublishInboundDiagnostics(1_000, 1_250, 'jsonl'), true);
});

test('inbound diagnostics always publish server-pong frames', () => {
  assert.equal(shouldPublishInboundDiagnostics(1_000, 1_001, 'server-pong'), true);
});
