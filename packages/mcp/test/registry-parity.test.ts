import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, PC_RIG_TOOL_NAMES } from '../src/server.ts';
import { PC_RIG_HANDLERS } from '../src/tools/handlers.ts';
import { PC_RIG_TOOL_REGISTRY } from '@pc/domain';
import { TOOL_CATALOG } from '@pc/domain';

// Slice 016 — the DRIFT-KILLER. The registry is the ONE ordered source; every
// view derives from it. This test makes the five surfaces a single bijection so
// half-adding a tool (registry without handler, handler without registry, a
// catalog slug not in the registry, etc.) FAILS the build. There is no longer
// any array to half-edit.

const stripPrefix = (slug: string) => slug.replace(/^mcp__pc-rig__/, '');

const registryNames = PC_RIG_TOOL_REGISTRY.map((d) => d.name);
const registryNameSet = [...registryNames].sort();

test('handler map keys === registry names (set equality)', () => {
  assert.deepEqual(Object.keys(PC_RIG_HANDLERS).sort(), registryNameSet);
});

test('PC_RIG_TOOL_NAMES (stripped) === registry names (set equality)', () => {
  assert.deepEqual([...PC_RIG_TOOL_NAMES].map(stripPrefix).sort(), registryNameSet);
});

test('TOOL_CATALOG pc-rig slugs (stripped) === registry names (set equality)', () => {
  const catalogPcRig = TOOL_CATALOG.filter((e) => e.source === 'pc-rig')
    .map((e) => stripPrefix(e.slug))
    .sort();
  assert.deepEqual(catalogPcRig, registryNameSet);
});

test('TOOLS names === registry names IN REGISTRY ORDER (order-locked)', () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    registryNames,
  );
});

test('PC_RIG_TOOL_NAMES (stripped) === registry names IN REGISTRY ORDER', () => {
  assert.deepEqual([...PC_RIG_TOOL_NAMES].map(stripPrefix), registryNames);
});

test('every registry tool has a handler and vice versa (no half-add)', () => {
  for (const name of registryNames) {
    assert.ok(PC_RIG_HANDLERS[name], `registry tool with no handler: ${name}`);
  }
  for (const name of Object.keys(PC_RIG_HANDLERS)) {
    assert.ok(
      registryNames.includes(name),
      `handler with no registry entry: ${name}`,
    );
  }
});

test('TOOLS objects are zipped from registry metadata (name/description/inputSchema)', () => {
  assert.equal(TOOLS.length, PC_RIG_TOOL_REGISTRY.length);
  for (let i = 0; i < TOOLS.length; i++) {
    const def = PC_RIG_TOOL_REGISTRY[i];
    const tool = TOOLS[i];
    assert.equal(tool.name, def.name, `name mismatch at index ${i}`);
    assert.equal(tool.description, def.description, `description mismatch: ${def.name}`);
    assert.deepEqual(tool.inputSchema, def.inputSchema, `inputSchema mismatch: ${def.name}`);
  }
});
