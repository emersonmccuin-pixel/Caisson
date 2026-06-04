import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleWorkflowTool } from '../src/tools/workflows.ts';
import { makeFakeContext, ok, err, firstText } from './helpers.ts';

// 11D golden text-compat tests — byte-identical result strings + frozen wire.

test('pc_node_failed: local ack string, no HTTP call', async () => {
  const { ctx, calls } = makeFakeContext({ responder: () => ok('{}') });
  const res = await handleWorkflowTool(
    'pc_node_failed',
    { workflowRunId: 'R1', nodeId: 'N1', reason: 'broke' },
    ctx,
  );
  assert.equal(firstText(res), 'node failure signal registered for node N1 (run R1): broke');
  assert.equal(res!.isError, undefined);
  assert.equal(calls.length, 0);
});

test('pc_get_workflow success: emits raw body; GETs /api/workflows/:id', async () => {
  const serverBody = JSON.stringify({ ok: true, workflow: { id: 'WF1', slug: 'triage' } });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleWorkflowTool('pc_get_workflow', { id: 'WF1' }, ctx);
  assert.equal(firstText(res), serverBody);
  assert.equal(calls[0].path, '/api/workflows/WF1');
});

test('pc_get_workflow failure: exact failure string', async () => {
  const { ctx } = makeFakeContext({ responder: () => err(404, 'nope') });
  const res = await handleWorkflowTool('pc_get_workflow', { id: 'WF1' }, ctx);
  assert.equal(firstText(res), 'pc_get_workflow failed (404): nope');
  assert.equal(res!.isError, true);
});

test('pc_fire_workflow by ULID: posts to /fire, emits raw body', async () => {
  const ulid = '01HFGHJKMNPQRSTVWXYZ012345'; // 26 chars, valid alphabet
  const serverBody = JSON.stringify({ ok: true, runId: 'RUN1', rootWorkItemId: 'WI1' });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleWorkflowTool('pc_fire_workflow', { workflow: ulid }, ctx);
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: `/api/workflows/${ulid}/fire`,
    body: { projectId: 'P01' },
  });
});

test('pc_fire_workflow with work_item_id: fires ON the existing card', async () => {
  const ulid = '01HFGHJKMNPQRSTVWXYZ012345';
  const wi = '01HFGHJKMNPQRSTVWXYZ0WI001';
  const serverBody = JSON.stringify({ ok: true, runId: 'RUN1', rootWorkItemId: wi });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleWorkflowTool(
    'pc_fire_workflow',
    { workflow: ulid, work_item_id: wi },
    ctx,
  );
  assert.equal(firstText(res), serverBody);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: `/api/workflows/${ulid}/fire`,
    body: { projectId: 'P01', workItemId: wi },
  });
});

test('pc_fire_workflow by slug: resolves via list then fires', async () => {
  const serverBody = JSON.stringify({ ok: true, runId: 'RUN1' });
  const { ctx, calls } = makeFakeContext({
    responder: (method, path) => {
      if (path.startsWith('/api/workflows?projectId=')) {
        return ok({ workflows: [{ id: 'WFID', slug: 'triage' }] });
      }
      return ok(serverBody);
    },
  });
  const res = await handleWorkflowTool('pc_fire_workflow', { workflow: 'triage' }, ctx);
  assert.equal(firstText(res), serverBody);
  assert.equal(calls[0].path, '/api/workflows?projectId=P01');
  assert.equal(calls[1].path, '/api/workflows/WFID/fire');
});

test('pc_fire_workflow failure: exact failure string', async () => {
  const ulid = '01HFGHJKMNPQRSTVWXYZ012345';
  const { ctx } = makeFakeContext({ responder: () => err(400, 'disabled') });
  const res = await handleWorkflowTool('pc_fire_workflow', { workflow: ulid }, ctx);
  assert.equal(firstText(res), 'pc_fire_workflow failed (400): disabled');
  assert.equal(res!.isError, true);
});

test('pc_list_workflows success: emits raw body', async () => {
  const serverBody = JSON.stringify({ workflows: [{ id: 'WF1', slug: 'triage' }] });
  const { ctx, calls } = makeFakeContext({ responder: () => ok(serverBody) });
  const res = await handleWorkflowTool('pc_list_workflows', {}, ctx);
  assert.equal(firstText(res), serverBody);
  assert.equal(calls[0].path, '/api/workflows?projectId=P01');
});
