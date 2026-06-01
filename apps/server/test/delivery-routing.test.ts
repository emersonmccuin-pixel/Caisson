import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  envDeliveryRouter,
  fixedDeliveryRouter,
  readDeliveryMode,
  type DeliveryFlow,
} from '../src/services/delivery-routing.ts';

const FLOWS: DeliveryFlow[] = ['agent', 'workflow-review', 'webhook'];
const ENV_KEYS = {
  agent: 'PC_DELIVERY_AGENT',
  'workflow-review': 'PC_DELIVERY_WORKFLOW_REVIEW',
  webhook: 'PC_DELIVERY_WEBHOOK',
} as const;

function clearEnv(): void {
  for (const k of Object.values(ENV_KEYS)) delete process.env[k];
}

test('default (no env) resolves every flow to mailbox — slice 017 Phase A flip', () => {
  clearEnv();
  for (const flow of FLOWS) assert.equal(readDeliveryMode(flow), 'mailbox');
  clearEnv();
});

test('unknown / garbage value falls back to mailbox (the new default)', () => {
  clearEnv();
  for (const flow of FLOWS) {
    process.env[ENV_KEYS[flow]] = 'nonsense';
    assert.equal(readDeliveryMode(flow), 'mailbox');
  }
  clearEnv();
});

test('explicit channel value still forces channel; case-insensitive + trimmed', () => {
  clearEnv();
  process.env.PC_DELIVERY_AGENT = '  ChAnnel ';
  assert.equal(readDeliveryMode('agent'), 'channel');
  clearEnv();
});

test('the three flows are independent', () => {
  clearEnv();
  process.env.PC_DELIVERY_AGENT = 'channel';
  // others unset → default mailbox
  assert.equal(readDeliveryMode('agent'), 'channel');
  assert.equal(readDeliveryMode('workflow-review'), 'mailbox');
  assert.equal(readDeliveryMode('webhook'), 'mailbox');
  clearEnv();
});

test('envDeliveryRouter reads from env per flow', () => {
  clearEnv();
  process.env.PC_DELIVERY_WEBHOOK = 'channel';
  const router = envDeliveryRouter();
  assert.equal(router.mode('webhook'), 'channel');
  assert.equal(router.mode('agent'), 'mailbox');
  clearEnv();
});

test('fixedDeliveryRouter is the injectable test seam (unspecified ⟹ channel)', () => {
  const router = fixedDeliveryRouter({ agent: 'mailbox' });
  assert.equal(router.mode('agent'), 'mailbox');
  assert.equal(router.mode('workflow-review'), 'channel');
  assert.equal(router.mode('webhook'), 'channel');
});
