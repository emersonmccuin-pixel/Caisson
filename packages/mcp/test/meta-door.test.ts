// FD-16 — pc_find_tool / pc_call_tool door behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleMetaTool } from '../src/tools/meta.ts';
import type { ToolContext, ToolResult } from '../src/tools/context.ts';

const ctx = {} as ToolContext; // the door itself never touches ctx

function fakeDispatch(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  return async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    calls.push({ name, args });
    return { content: [{ type: 'text', text: `inner:${name}` }] };
  };
}

test('pc_find_tool surfaces an on-demand tool with schema + call instructions', async () => {
  const r = await handleMetaTool('pc_find_tool', { query: 'pc_get_workflow' }, ctx, fakeDispatch([]));
  assert.ok(r && !r.isError);
  const text = r!.content.map((c) => c.text).join('\n');
  // Exact-name hit must rank first.
  assert.match(r!.content[0]!.text, /^pc_get_workflow/);
  assert.match(text, /on-demand — call via pc_call_tool/);
  assert.match(text, /input schema:/);
});

test('pc_find_tool labels first-order and worker matches without schemas', async () => {
  const r = await handleMetaTool('pc_find_tool', { query: 'invoke agent dispatch' }, ctx, fakeDispatch([]));
  const text = r!.content.map((c) => c.text).join('\n');
  assert.match(text, /pc_invoke_agent/);
  assert.match(text, /first-order/);
});

test('pc_call_tool dispatches an on-demand tool and stamps the door', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const r = await handleMetaTool(
    'pc_call_tool',
    { name: 'pc_get_workflow', args: { id: 'wf-1' } },
    ctx,
    fakeDispatch(calls),
  );
  assert.deepEqual(calls, [{ name: 'pc_get_workflow', args: { id: 'wf-1' } }]);
  assert.equal(r!.content[0]!.text, '[pc_call_tool → pc_get_workflow]');
  assert.equal(r!.content[1]!.text, 'inner:pc_get_workflow');
});

test('pc_call_tool refuses worker, first-order, and unknown names — and never dispatches', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const [target, expect] of [
    ['pc_submit_deliverable', /worker-side/],
    ['pc_invoke_agent', /first-order/],
    ['pc_call_tool', /first-order/], // structural no-recursion
    ['pc_nonexistent', /unknown tool/],
  ] as const) {
    const r = await handleMetaTool('pc_call_tool', { name: target }, ctx, fakeDispatch(calls));
    assert.equal(r!.isError, true, `${target} must be refused`);
    assert.match(r!.content[0]!.text, expect);
  }
  assert.deepEqual(calls, []);
});

test('pc_find_tool with no hits says so without erroring', async () => {
  const r = await handleMetaTool('pc_find_tool', { query: 'zzzzqqq' }, ctx, fakeDispatch([]));
  assert.ok(r && !r.isError);
  assert.match(r!.content[0]!.text, /No catalog tool matches/);
});
