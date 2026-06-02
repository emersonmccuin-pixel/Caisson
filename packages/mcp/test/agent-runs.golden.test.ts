import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleAgentRunTool } from '../src/tools/agent-runs.ts';
import { makeFakeContext, ok, err, firstText } from './helpers.ts';

// 11E golden text-compat tests — byte-identical result strings + frozen wire.

const BASE = {
  projectId: 'P01',
  dispatcherSessionId: 'DSESS',
  agentRunId: 'AR1',
};

test('pc_invoke_agent success: emits raw body; posts invoke payload', async () => {
  const serverBody = JSON.stringify({ ok: true, mode: 'async', runId: 'RUN1' });
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool(
    'pc_invoke_agent',
    { name: 'researcher', input: 'Begin.', workItemId: 'WI1' },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/agents/researcher/invoke',
    body: {
      input: 'Begin.',
      parentInvokeDepth: 0,
      dispatcherSessionId: 'DSESS',
      workItemId: 'WI1',
    },
  });
});

test('pc_invoke_agent failure: exact failure string', async () => {
  const { ctx } = makeFakeContext({ ...BASE, responder: () => err(500, 'boom') });
  const res = await handleAgentRunTool(
    'pc_invoke_agent',
    { name: 'researcher', input: 'Begin.' },
    ctx,
  );
  assert.equal(firstText(res), 'pc_invoke_agent failed (500): boom');
  assert.equal(res!.isError, true);
});

test('pc_continue_agent success: emits raw body; posts continue payload', async () => {
  const serverBody = JSON.stringify({ ok: true, runId: 'RUN2' });
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool(
    'pc_continue_agent',
    { runId: 'RUN1', input: 'keep going' },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/agent-runs/RUN1/continue',
    body: { input: 'keep going', dispatcherSessionId: 'DSESS' },
  });
});

test('pc_ask_orchestrator success: emits raw body; posts pending-ask', async () => {
  const serverBody = JSON.stringify({ ok: true, pendingAskId: 'PA1', status: 'waiting' });
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool(
    'pc_ask_orchestrator',
    { question: 'which way?' },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/agent-pending-asks',
    body: { agentRunId: 'AR1', kind: 'orchestrator', promptBody: 'which way?' },
  });
});

test('pc_ask_user with options: kind=user, options forwarded', async () => {
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok('{}') });
  await handleAgentRunTool(
    'pc_ask_user',
    { question: 'pick', options: [{ value: 'a', label: 'A' }] },
    ctx,
  );
  assert.deepEqual(calls[0].body, {
    agentRunId: 'AR1',
    kind: 'user',
    promptBody: 'pick',
    options: [{ value: 'a', label: 'A' }],
  });
});

test('pc_request_approval success: kind=approval', async () => {
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok('{}') });
  await handleAgentRunTool(
    'pc_request_approval',
    { decision: 'proceed?', options: [{ value: 'y', label: 'Yes' }] },
    ctx,
  );
  assert.deepEqual(calls[0].body, {
    agentRunId: 'AR1',
    kind: 'approval',
    promptBody: 'proceed?',
    options: [{ value: 'y', label: 'Yes' }],
  });
});

test('pc_request_approval failure: exact failure string preserves toolName prefix', async () => {
  const { ctx } = makeFakeContext({ ...BASE, responder: () => err(409, 'conflict') });
  const res = await handleAgentRunTool(
    'pc_request_approval',
    { decision: 'proceed?', options: [{ value: 'y', label: 'Yes' }] },
    ctx,
  );
  assert.equal(firstText(res), 'pc_request_approval failed (409): conflict');
  assert.equal(res!.isError, true);
});

test('pc_answer_pending success: emits raw body; posts answer', async () => {
  const serverBody = JSON.stringify({ ok: true, cause: 'answered' });
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool(
    'pc_answer_pending',
    { pendingAskId: 'PA1', answer: '42', answeredBy: 'orchestrator' },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/agent-pending-asks/PA1/answer',
    body: { answer: '42', answeredBy: 'orchestrator' },
  });
});

test('pc_submit_deliverable success: posts to run deliverable route, merges kind', async () => {
  const serverBody = JSON.stringify({ ok: true, contractId: 'C1', status: 'submitted' });
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool(
    'pc_submit_deliverable',
    { kind: 'answer', deliverable: { text: 'Node LTS is 22.' }, report: 'done' },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/projects/P01/agent-runs/AR1/deliverable',
    body: { agentRunId: 'AR1', deliverable: { text: 'Node LTS is 22.', kind: 'answer' }, report: 'done' },
  });
});

test('pc_submit_deliverable requires PC_AGENT_RUN_ID', async () => {
  const { ctx } = makeFakeContext({ projectId: 'P01', dispatcherSessionId: 'D', responder: () => ok('{}') });
  const res = await handleAgentRunTool('pc_submit_deliverable', { kind: 'answer' }, ctx);
  assert.equal(res!.isError, true);
  assert.match(firstText(res), /PC_AGENT_RUN_ID not set/);
});

test('pc_submit_deliverable failure: exact failure string', async () => {
  const { ctx } = makeFakeContext({ ...BASE, responder: () => err(400, 'kind-mismatch') });
  const res = await handleAgentRunTool('pc_submit_deliverable', { kind: 'repo' }, ctx);
  assert.equal(firstText(res), 'pc_submit_deliverable failed (400): kind-mismatch');
  assert.equal(res!.isError, true);
});

test('pc_list_my_runs success: emits raw body (left raw — no covering DTO)', async () => {
  const serverBody = JSON.stringify({ ok: true, runs: [] });
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool('pc_list_my_runs', {}, ctx);
  assert.equal(firstText(res), serverBody);
  assert.equal(calls[0].path, '/api/projects/P01/agent-runs/by-dispatcher?dispatcherSessionId=DSESS');
});

test('pc_inspect_agent_run success: emits raw body (left raw)', async () => {
  const serverBody = JSON.stringify({ ok: true, inspection: { runId: 'RUN1' } });
  const { ctx, calls } = makeFakeContext({ ...BASE, responder: () => ok(serverBody) });
  const res = await handleAgentRunTool('pc_inspect_agent_run', { runId: 'RUN1' }, ctx);
  assert.equal(firstText(res), serverBody);
  assert.equal(calls[0].path, '/api/projects/P01/agent-runs/RUN1/inspect');
});
