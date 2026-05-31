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

test('default (no env) resolves every flow to channel — byte-identical to today', () => {
  clearEnv();
  for (const flow of FLOWS) assert.equal(readDeliveryMode(flow), 'channel');
  clearEnv();
});

test('unknown / garbage value falls back to channel (fail-safe)', () => {
  clearEnv();
  for (const flow of FLOWS) {
    process.env[ENV_KEYS[flow]] = 'nonsense';
    assert.equal(readDeliveryMode(flow), 'channel');
  }
  clearEnv();
});

test('explicit mailbox value resolves to mailbox; case-insensitive + trimmed', () => {
  clearEnv();
  process.env.PC_DELIVERY_AGENT = '  MailBox ';
  assert.equal(readDeliveryMode('agent'), 'mailbox');
  clearEnv();
});

test('the three flows are independent', () => {
  clearEnv();
  process.env.PC_DELIVERY_AGENT = 'mailbox';
  // others unset
  assert.equal(readDeliveryMode('agent'), 'mailbox');
  assert.equal(readDeliveryMode('workflow-review'), 'channel');
  assert.equal(readDeliveryMode('webhook'), 'channel');
  clearEnv();
});

test('envDeliveryRouter reads from env per flow', () => {
  clearEnv();
  process.env.PC_DELIVERY_WEBHOOK = 'mailbox';
  const router = envDeliveryRouter();
  assert.equal(router.mode('webhook'), 'mailbox');
  assert.equal(router.mode('agent'), 'channel');
  clearEnv();
});

test('fixedDeliveryRouter is the injectable test seam (unspecified ⟹ channel)', () => {
  const router = fixedDeliveryRouter({ agent: 'mailbox' });
  assert.equal(router.mode('agent'), 'mailbox');
  assert.equal(router.mode('workflow-review'), 'channel');
  assert.equal(router.mode('webhook'), 'channel');
});
