// Workflow `call` node — DagExecutor behaviour.
//
// A call node dispatches through the callTool dep, captures its output into
// the node record (feeding downstream `$callId.output` refs), and settles as a
// TYPED failure on a tool error (positive receipt — never a fake success).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ULID, WorkflowV2 } from '@pc/domain';
import {
  DagExecutor,
  type DagExecutorDeps,
  type DagNodeContext,
  type NodeOutcome,
} from '../src/services/dag-executor.ts';

function baseDeps(over: Partial<DagExecutorDeps> = {}): DagExecutorDeps {
  return {
    resolveRef: () => () => '',
    dispatchAgent: async (): Promise<NodeOutcome> => ({ state: 'completed' }),
    callTool: async (): Promise<NodeOutcome> => ({ state: 'completed', output: '' }),
    moveCard: async () => ({ ok: true }),
    mergeToDev: async () => ({ outcome: 'merged' as const }),
    requestReview: async () => {},
    persist: () => {},
    event: () => {},
    isCancelled: () => false,
    ...over,
  };
}

const ctxBase = {
  runId: 'run-c' as ULID,
  rootWorkItemId: 'wi-c' as ULID,
  worktreePath: null,
};

function callWorkflow(): WorkflowV2.Workflow {
  return {
    id: 'wf-call',
    name: 'Call Test',
    nodes: [
      {
        id: 'fetch-data',
        kind: 'call',
        server: 'snowflake',
        tool: 'run_query',
        args: { sql: 'select 1' },
        next: ['summarise'],
      },
      { id: 'summarise', kind: 'agent', agent: 'writer', task: 'Summarise: $fetch-data.output' },
    ],
  };
}

test('call node success: output captured, downstream agent runs, run completes', async () => {
  const calls: { node: WorkflowV2.CallNode; ctx: DagNodeContext }[] = [];
  const events: string[] = [];
  const deps = baseDeps({
    callTool: async (node, ctx): Promise<NodeOutcome> => {
      calls.push({ node, ctx });
      return { state: 'completed', output: '{"rows":1}' };
    },
    event: (ev) => events.push(ev.type),
  });
  const exec = DagExecutor.start(callWorkflow(), deps, ctxBase);
  const status = await exec.advance();
  assert.equal(status, 'completed');
  assert.equal(calls.length, 1, 'callTool invoked exactly once');
  assert.equal(calls[0]!.node.tool, 'run_query');
  assert.equal(exec.getState().nodes['fetch-data']?.state, 'completed');
  assert.equal(exec.getState().nodes['fetch-data']?.output, '{"rows":1}');
  assert.equal(exec.getState().nodes['summarise']?.state, 'completed');
  assert.ok(events.includes('node_completed'));
});

test('call node failure: node fails typed, downstream skipped, run fails with reason', async () => {
  const persisted: { status: string; lastReason?: string }[] = [];
  const failures: string[] = [];
  const deps = baseDeps({
    callTool: async (): Promise<NodeOutcome> => ({
      state: 'failed',
      error: 'call snowflake.run_query failed: timeout',
    }),
    persist: (_s, status, opts) =>
      persisted.push({ status, ...(opts?.lastReason ? { lastReason: opts.lastReason } : {}) }),
    notifyRunFailed: (reason) => failures.push(reason),
  });
  const exec = DagExecutor.start(callWorkflow(), deps, ctxBase);
  const status = await exec.advance();
  assert.equal(status, 'failed');
  assert.equal(exec.getState().nodes['fetch-data']?.state, 'failed');
  assert.equal(exec.getState().nodes['summarise']?.state, 'skipped', 'downstream skipped');
  const last = persisted[persisted.length - 1]!;
  assert.equal(last.status, 'failed');
  assert.match(last.lastReason ?? '', /snowflake\.run_query/, 'failure reason carries the call');
  assert.equal(failures.length, 1, 'notifyRunFailed fired once');
});

test('callTool throwing settles the node failed (no unhandled rejection)', async () => {
  const deps = baseDeps({
    callTool: async (): Promise<NodeOutcome> => {
      throw new Error('transport exploded');
    },
  });
  const exec = DagExecutor.start(callWorkflow(), deps, ctxBase);
  const status = await exec.advance();
  assert.equal(status, 'failed');
  assert.match(exec.getState().nodes['fetch-data']?.error ?? '', /transport exploded/);
});

test('when: guard on a call node skips it without invoking the tool', async () => {
  let invoked = 0;
  const wf: WorkflowV2.Workflow = {
    id: 'wf-when',
    name: 'When Test',
    nodes: [
      { id: 'probe', kind: 'agent', agent: 'researcher', task: 'go', next: ['notify'] },
      {
        id: 'notify',
        kind: 'call',
        server: 'gmail',
        tool: 'create_draft',
        when: "$probe.output == 'send'",
      },
    ],
  };
  const deps = baseDeps({
    resolveRef: () => () => 'do-not-send',
    callTool: async (): Promise<NodeOutcome> => {
      invoked += 1;
      return { state: 'completed', output: '' };
    },
  });
  const exec = DagExecutor.start(wf, deps, ctxBase);
  const status = await exec.advance();
  assert.equal(status, 'completed');
  assert.equal(invoked, 0, 'guarded call never invoked');
  assert.equal(exec.getState().nodes['notify']?.state, 'skipped');
});
