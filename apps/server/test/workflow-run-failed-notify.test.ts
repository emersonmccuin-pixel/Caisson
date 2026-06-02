// Workflow-engine redesign (slice 7) — a failed run notifies the human inbox +
// the project orchestrator. This pins the EXECUTOR hook: when a run finalizes
// `failed`, the executor fires `notifyRunFailed(reason)` exactly once, carrying
// the derived failure reason. The two-recipient mailbox fan-out
// (deliverWorkflowRunFailed in index.ts) rides this hook and is typechecked at
// its call site; the end-to-end inbox delivery is covered by the e2e re-fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ULID, WorkflowV2 } from '@pc/domain';
import { DagExecutor, type DagExecutorDeps, type NodeOutcome } from '../src/services/dag-executor.ts';

function baseDeps(over: Partial<DagExecutorDeps> = {}): DagExecutorDeps {
  return {
    resolveRef: () => () => '',
    dispatchAgent: async (): Promise<NodeOutcome> => ({ state: 'completed' }),
    runCommand: async (): Promise<NodeOutcome> => ({ state: 'completed' }),
    moveWorkItem: async (): Promise<NodeOutcome> => ({ state: 'completed' }),
    requestReview: async () => {},
    persist: () => {},
    event: () => {},
    isCancelled: () => false,
    holdForHuman: () => {},
    ...over,
  };
}

const ctxBase = { runId: 'run-1' as ULID, rootWorkItemId: 'wi-1' as ULID, worktreePath: null };

function oneAgentWorkflow(): WorkflowV2.Workflow {
  return {
    id: 'wf',
    name: 'Test Flow',
    triggers: [],
    nodes: [{ id: 'a', kind: 'agent', agent: 'writer', task: 'do it' }],
  };
}

test('a failed run fires notifyRunFailed once with the derived reason', async () => {
  const calls: string[] = [];
  const deps = baseDeps({
    dispatchAgent: async () => ({ state: 'failed', error: 'boom' }),
    notifyRunFailed: (reason) => calls.push(reason),
  });

  const exec = DagExecutor.start(oneAgentWorkflow(), deps, ctxBase);
  const status = await exec.advance();

  assert.equal(status, 'failed');
  assert.equal(calls.length, 1, 'notifyRunFailed fires exactly once');
  assert.match(calls[0]!, /boom/, 'carries the failing node reason');
});

test('a completed run does NOT fire notifyRunFailed', async () => {
  const calls: string[] = [];
  const deps = baseDeps({
    dispatchAgent: async () => ({ state: 'completed' }),
    notifyRunFailed: (reason) => calls.push(reason),
  });

  const exec = DagExecutor.start(oneAgentWorkflow(), deps, ctxBase);
  const status = await exec.advance();

  assert.equal(status, 'completed');
  assert.equal(calls.length, 0, 'no failure notice on a successful run');
});
