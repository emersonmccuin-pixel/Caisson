import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { OrchestratorReviewNode, Workflow, WorkflowRun } from '@pc/domain';

import {
  runOrchestratorReviewStep,
  type OrchestratorReviewStepDeps,
} from '../src/services/orchestrator-review-step.ts';

const node = {
  id: 'review-1',
  'orchestrator-review': { prompt: 'review this', artifact: null },
} as unknown as OrchestratorReviewNode;

const run = { id: 'run-1' } as unknown as WorkflowRun;
const workflow = { id: 'wf-1' } as unknown as Workflow;

function baseDeps(over: Partial<OrchestratorReviewStepDeps> = {}): OrchestratorReviewStepDeps {
  return {
    workflow,
    substituteTemplate: (t) => t,
    postChannel: async () => {},
    broadcast: () => {},
    ...over,
  };
}

test('gate=channel (no deliverReview) — postChannel is called; review-pending broadcast fires', async () => {
  let postChannelCalls = 0;
  const broadcasts: unknown[] = [];
  const res = await runOrchestratorReviewStep(node, run, baseDeps({
    postChannel: async () => {
      postChannelCalls += 1;
    },
    broadcast: (e) => broadcasts.push(e),
  }));
  assert.equal(res.kind, 'async');
  assert.equal(postChannelCalls, 1);
  assert.equal(broadcasts.length, 1);
});

test('gate=mailbox (deliverReview returns true) — postChannel is SKIPPED; broadcast still fires', async () => {
  let postChannelCalls = 0;
  const deliverReviewArgs: Array<{ runId: string; nodeId: string }> = [];
  const broadcasts: unknown[] = [];
  const res = await runOrchestratorReviewStep(node, run, baseDeps({
    postChannel: async () => {
      postChannelCalls += 1;
    },
    deliverReview: ({ runId, nodeId }) => {
      deliverReviewArgs.push({ runId, nodeId });
      return true;
    },
    broadcast: (e) => broadcasts.push(e),
  }));
  assert.equal(res.kind, 'async');
  assert.equal(postChannelCalls, 0, 'mailbox gate must NOT POST to /channel');
  assert.deepEqual(deliverReviewArgs, [{ runId: 'run-1', nodeId: 'review-1' }]);
  assert.equal(broadcasts.length, 1, 'review-pending broadcast fires in both positions');
});

test('deliverReview returning false falls back to postChannel (no-double-delivery)', async () => {
  let postChannelCalls = 0;
  let deliverCalls = 0;
  await runOrchestratorReviewStep(node, run, baseDeps({
    postChannel: async () => {
      postChannelCalls += 1;
    },
    deliverReview: () => {
      deliverCalls += 1;
      return false; // gate=channel decision inside the seam
    },
  }));
  assert.equal(deliverCalls, 1);
  assert.equal(postChannelCalls, 1, 'a false return means Channel still delivers exactly once');
});
