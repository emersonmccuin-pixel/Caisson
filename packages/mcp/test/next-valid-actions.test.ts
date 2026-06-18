import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleWorkItemTool } from '../src/tools/work-items.ts';
import { handleAgentRunTool } from '../src/tools/agent-runs.ts';
import { makeFakeContext, ok, err, firstText } from './helpers.ts';

// A1 — next_valid_actions: verify the field is present and correct on the
// highest-value populations. The field is OPTIONAL and ADDITIVE — the tests
// below only assert the cases that are explicitly wired; unlisted cases may
// return undefined (no hint), which is also valid.

// ── work-items ────────────────────────────────────────────────────────────────

test('pc_create_work_item success: next_valid_actions includes invoke + move + update', async () => {
  const { ctx } = makeFakeContext({ responder: () => ok('{"ok":true,"workItem":{"id":"W1"}}', 201) });
  const res = await handleWorkItemTool('pc_create_work_item', { title: 'T' }, ctx);
  assert.ok(res);
  assert.equal(res!.isError, undefined);
  assert.ok(Array.isArray(res!.next_valid_actions), 'next_valid_actions should be an array');
  assert.ok(res!.next_valid_actions!.includes('pc_invoke_agent'), 'should include pc_invoke_agent');
  assert.ok(res!.next_valid_actions!.includes('pc_move_work_item'), 'should include pc_move_work_item');
  assert.ok(res!.next_valid_actions!.includes('pc_update_work_item'), 'should include pc_update_work_item');
});

test('pc_create_work_item HTTP failure: next_valid_actions includes stages + projects', async () => {
  const { ctx } = makeFakeContext({ responder: () => err(400, 'invalid stage') });
  const res = await handleWorkItemTool('pc_create_work_item', { title: 'T' }, ctx);
  assert.ok(res);
  assert.equal(res!.isError, true);
  assert.ok(Array.isArray(res!.next_valid_actions), 'next_valid_actions should be an array');
  assert.ok(res!.next_valid_actions!.includes('pc_list_stages'), 'should include pc_list_stages');
  assert.ok(res!.next_valid_actions!.includes('pc_list_projects'), 'should include pc_list_projects');
});

test('pc_create_work_item validation error (missing title): no next_valid_actions needed', async () => {
  const { ctx } = makeFakeContext({ responder: () => ok('{}') });
  const res = await handleWorkItemTool('pc_create_work_item', {}, ctx);
  assert.equal(firstText(res), 'pc_create_work_item: title required');
  assert.equal(res!.isError, true);
});

test('pc_create_agent_work_item success: next_valid_actions includes list-runs + inspect', async () => {
  const { ctx } = makeFakeContext({ responder: () => ok('{"ok":true,"workItem":{"id":"W2"}}', 201) });
  const res = await handleWorkItemTool(
    'pc_create_agent_work_item',
    { title: 'T', task: 'do stuff', pod: 'researcher' },
    ctx,
  );
  assert.ok(res);
  assert.equal(res!.isError, undefined);
  assert.ok(Array.isArray(res!.next_valid_actions));
  assert.ok(res!.next_valid_actions!.includes('pc_list_my_runs'));
  assert.ok(res!.next_valid_actions!.includes('pc_inspect_agent_run'));
});

test('pc_create_agent_work_item HTTP failure: next_valid_actions includes list-agents + invoke', async () => {
  const { ctx } = makeFakeContext({ responder: () => err(404, 'pod not found') });
  const res = await handleWorkItemTool(
    'pc_create_agent_work_item',
    { title: 'T', task: 'do stuff', pod: 'unknown-pod' },
    ctx,
  );
  assert.ok(res);
  assert.equal(res!.isError, true);
  assert.ok(Array.isArray(res!.next_valid_actions));
  assert.ok(res!.next_valid_actions!.includes('pc_list_agents'));
  assert.ok(res!.next_valid_actions!.includes('pc_invoke_agent'));
});

test('pc_get_work_item success: next_valid_actions includes update + move + attach', async () => {
  const { ctx } = makeFakeContext({ responder: () => ok('{"ok":true,"workItem":{"id":"W3"}}') });
  const res = await handleWorkItemTool('pc_get_work_item', { id: 'W3' }, ctx);
  assert.ok(res);
  assert.equal(res!.isError, undefined);
  assert.ok(Array.isArray(res!.next_valid_actions));
  assert.ok(res!.next_valid_actions!.includes('pc_update_work_item'));
  assert.ok(res!.next_valid_actions!.includes('pc_move_work_item'));
  assert.ok(res!.next_valid_actions!.includes('pc_attach_to_work_item'));
});

test('pc_get_work_item HTTP failure: next_valid_actions includes list + search', async () => {
  const { ctx } = makeFakeContext({ responder: () => err(404, 'not found') });
  const res = await handleWorkItemTool('pc_get_work_item', { id: 'MISSING' }, ctx);
  assert.ok(res);
  assert.equal(res!.isError, true);
  assert.ok(Array.isArray(res!.next_valid_actions));
  assert.ok(res!.next_valid_actions!.includes('pc_list_work_items'));
  assert.ok(res!.next_valid_actions!.includes('pc_search_work_items'));
});

// ── agent-runs ────────────────────────────────────────────────────────────────

const BASE = { projectId: 'P01', dispatcherSessionId: 'DSESS', agentRunId: 'AR1' };

test('pc_invoke_agent success: next_valid_actions includes list-runs + inspect', async () => {
  const { ctx } = makeFakeContext({ ...BASE, responder: () => ok('{"ok":true,"runId":"RUN1"}') });
  const res = await handleAgentRunTool('pc_invoke_agent', { name: 'researcher', input: 'go' }, ctx);
  assert.ok(res);
  assert.equal(res!.isError, undefined);
  assert.ok(Array.isArray(res!.next_valid_actions));
  assert.ok(res!.next_valid_actions!.includes('pc_list_my_runs'));
  assert.ok(res!.next_valid_actions!.includes('pc_inspect_agent_run'));
});

test('pc_invoke_agent HTTP failure: next_valid_actions includes list-agents + create-agent-work-item', async () => {
  const { ctx } = makeFakeContext({ ...BASE, responder: () => err(404, 'agent not found') });
  const res = await handleAgentRunTool('pc_invoke_agent', { name: 'badname', input: 'go' }, ctx);
  assert.ok(res);
  assert.equal(res!.isError, true);
  assert.ok(Array.isArray(res!.next_valid_actions));
  assert.ok(res!.next_valid_actions!.includes('pc_list_agents'));
  assert.ok(res!.next_valid_actions!.includes('pc_create_agent_work_item'));
});

test('pc_submit_deliverable HTTP failure: next_valid_actions includes get-contract + ask-orchestrator', async () => {
  const { ctx } = makeFakeContext({ ...BASE, responder: () => err(400, 'kind-mismatch') });
  const res = await handleAgentRunTool('pc_submit_deliverable', { kind: 'repo' }, ctx);
  assert.ok(res);
  assert.equal(res!.isError, true);
  assert.ok(Array.isArray(res!.next_valid_actions));
  assert.ok(res!.next_valid_actions!.includes('pc_get_contract'));
  assert.ok(res!.next_valid_actions!.includes('pc_ask_orchestrator'));
});

// ── backward compat: existing shape still intact ──────────────────────────────

test('pc_invoke_agent success: existing content shape unchanged (backward compat)', async () => {
  const body = '{"ok":true,"runId":"RUN2"}';
  const { ctx } = makeFakeContext({ ...BASE, responder: () => ok(body) });
  const res = await handleAgentRunTool('pc_invoke_agent', { name: 'researcher', input: 'go' }, ctx);
  assert.equal(firstText(res), body);
  assert.equal(res!.isError, undefined);
});

test('pc_create_work_item success: existing content[0] text unchanged (backward compat)', async () => {
  const body = '{"ok":true,"workItem":{"id":"W4"}}';
  const { ctx } = makeFakeContext({ responder: () => ok(body, 201) });
  const res = await handleWorkItemTool('pc_create_work_item', { title: 'T' }, ctx);
  assert.equal(res!.content[0].text, body);
  assert.ok(res!.content[1].text.includes('system formatting reminder'));
});
