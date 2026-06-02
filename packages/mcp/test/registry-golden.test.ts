import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TOOLS, PC_RIG_TOOL_NAMES } from '../src/server.ts';
import {
  TOOL_CATALOG,
  descriptionOf,
  friendlyName,
  lookupTool,
  type ToolCatalogEntry,
} from '@pc/domain';

// Slice 016 — WIRE-FROZEN golden snapshot. Captured from the THREE hand-sources
// PRE-migration (`__golden__.json`); these assertions must hold byte-identical
// AFTER the registry consolidation. Names, ListTools ordering, every inputSchema
// byte, PC_RIG_TOOL_NAMES, the TOOL_CATALOG per-slug values, and the
// descriptionOf / friendlyName / lookupTool outputs are the frozen surface.

interface Golden {
  listTools: Array<{ name: string; description: string; inputSchema: unknown }>;
  pcRigToolNames: string[];
  toolCatalog: ToolCatalogEntry[];
  capabilities: Record<string, { family: string }>;
}

const GOLDEN = JSON.parse(
  readFileSync(new URL('./__golden__.json', import.meta.url), 'utf-8'),
) as Golden;

test('ListTools {name, description, inputSchema} byte-identical + in order', () => {
  const live = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  assert.deepEqual(live, GOLDEN.listTools);
});

test('ListTools name ORDER is exactly the captured order', () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    GOLDEN.listTools.map((t) => t.name),
  );
});

test('PC_RIG_TOOL_NAMES array (order + contents) byte-identical', () => {
  assert.deepEqual([...PC_RIG_TOOL_NAMES], GOLDEN.pcRigToolNames);
});

test('TOOL_CATALOG pc-rig partition: every captured entry preserved by value', () => {
  const liveBySlug = new Map(TOOL_CATALOG.map((e) => [e.slug, e]));
  const goldenPcRig = GOLDEN.toolCatalog.filter((e) => e.source === 'pc-rig');
  for (const g of goldenPcRig) {
    const live = liveBySlug.get(g.slug);
    assert.ok(live, `pc-rig catalog entry missing post-migration: ${g.slug}`);
    assert.deepEqual(live, g, `pc-rig catalog entry changed: ${g.slug}`);
  }
  // No pc-rig entries added or dropped.
  const livePcRigSlugs = TOOL_CATALOG.filter((e) => e.source === 'pc-rig')
    .map((e) => e.slug)
    .sort();
  const goldenPcRigSlugs = goldenPcRig.map((e) => e.slug).sort();
  assert.deepEqual(livePcRigSlugs, goldenPcRigSlugs);
});

test('TOOL_CATALOG cc-builtin + mcp-server entries unchanged and in place', () => {
  const liveNonPcRig = TOOL_CATALOG.filter((e) => e.source !== 'pc-rig');
  const goldenNonPcRig = GOLDEN.toolCatalog.filter((e) => e.source !== 'pc-rig');
  // Hand-authored partitions keep their exact order + values.
  assert.deepEqual(liveNonPcRig, goldenNonPcRig);
});

test('descriptionOf / friendlyName / lookupTool identical for every captured slug', () => {
  for (const g of GOLDEN.toolCatalog) {
    assert.equal(friendlyName(g.slug), g.label, `friendlyName drift: ${g.slug}`);
    assert.equal(descriptionOf(g.slug), g.description, `descriptionOf drift: ${g.slug}`);
    assert.deepEqual(lookupTool(g.slug), g, `lookupTool drift: ${g.slug}`);
  }
});
