import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, PC_RIG_TOOL_NAMES } from '../src/server.ts';
import { CAPABILITIES } from '../src/capabilities.ts';

// 11A parity guard — the registry is a DERIVED lookup; TOOLS stays the sole
// source of truth. These tests protect the coupling (every TOOLS name has a
// registry entry; every registry key is a TOOLS name) so a future tool add
// can't silently drift the family map. They do NOT reorder or redeclare TOOLS.

test('every TOOLS name has a capability registry entry', () => {
  for (const tool of TOOLS) {
    assert.ok(
      CAPABILITIES[tool.name],
      `missing capability registry entry for tool: ${tool.name}`,
    );
  }
});

test('every capability registry key is a TOOLS name', () => {
  const toolNames = new Set(TOOLS.map((t) => t.name));
  for (const key of Object.keys(CAPABILITIES)) {
    assert.ok(toolNames.has(key), `registry key is not a TOOLS name: ${key}`);
  }
});

test('registry and TOOLS have identical name sets (full bijection)', () => {
  const toolNames = [...TOOLS.map((t) => t.name)].sort();
  const capNames = Object.keys(CAPABILITIES).sort();
  assert.deepEqual(capNames, toolNames);
});

test('PC_RIG_TOOL_NAMES is derived from TOOLS order, prefixed', () => {
  assert.deepEqual(
    [...PC_RIG_TOOL_NAMES],
    TOOLS.map((t) => `mcp__pc-rig__${t.name}`),
  );
});

test('every capability family is a known family tag', () => {
  const families = new Set([
    'work-item',
    'project',
    'workflow',
    'agent',
    'agent-run',
    'none',
  ]);
  for (const [name, cap] of Object.entries(CAPABILITIES)) {
    assert.ok(families.has(cap.family), `unknown family "${cap.family}" for ${name}`);
  }
});
