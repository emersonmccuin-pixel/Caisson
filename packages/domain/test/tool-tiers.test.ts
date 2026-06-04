// FD-16 — tier map ↔ registry parity guard. The tier map is a separate block
// (the wire-frozen registry entries stay untouched), so this test is what
// keeps the two from drifting: every registry tool has exactly one tier, and
// the tier map names nothing that isn't in the registry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PC_RIG_TOOL_REGISTRY_NAMES,
  PC_RIG_TOOL_TIERS,
} from '../src/tool-registry.ts';

test('every registry tool has a tier', () => {
  const missing = PC_RIG_TOOL_REGISTRY_NAMES.filter(
    (name) => PC_RIG_TOOL_TIERS[name] === undefined,
  );
  assert.deepEqual(missing, [], `tools missing a tier: ${missing.join(', ')}`);
});

test('the tier map names only registry tools', () => {
  const registered = new Set(PC_RIG_TOOL_REGISTRY_NAMES);
  const orphans = Object.keys(PC_RIG_TOOL_TIERS).filter((name) => !registered.has(name));
  assert.deepEqual(orphans, [], `tier entries for unknown tools: ${orphans.join(', ')}`);
});

test('the door tools are first-order and never reach themselves', () => {
  // pc_call_tool only dispatches tier 'on-demand'; the door tools being
  // first-order is what structurally prevents call→call recursion.
  assert.equal(PC_RIG_TOOL_TIERS['pc_find_tool'], 'first-order');
  assert.equal(PC_RIG_TOOL_TIERS['pc_call_tool'], 'first-order');
});

test('worker-side comms tools are never on-demand', () => {
  for (const name of [
    'pc_ask_orchestrator',
    'pc_ask_user',
    'pc_request_approval',
    'pc_node_failed',
    'pc_submit_deliverable',
    'pc_attach_to_work_item',
  ]) {
    assert.equal(PC_RIG_TOOL_TIERS[name], 'worker', `${name} must stay worker-side`);
  }
});
