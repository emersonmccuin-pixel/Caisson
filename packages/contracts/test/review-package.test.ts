import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDecisionContract,
  decisionContractHeaderText,
  isDecisionContract,
  isReviewPackage,
  isReviewWork,
  isReviewProvenance,
  isReviewAttempt,
  makeReviewPackage,
  parseReviewPackage,
  type ReviewPackage,
  type ReviewWork,
} from '../src/index.ts';

// ---- Fixtures ---------------------------------------------------------------

const provenance = {
  agentRunId: 'run-1',
  workItemId: 'wi-1',
  workflowNodeId: null,
  dispatchedAt: 1000,
};

function basePackage(work: ReviewWork): ReviewPackage {
  return makeReviewPackage({
    id: 'rp-1',
    producer: 'agent-verification',
    owner: 'human',
    title: 'Review my work',
    whatWasAsked: 'Write a plan',
    acceptanceCriteria: 'Three steps minimum',
    work,
    provenance,
  });
}

// ---- isReviewWork -----------------------------------------------------------

test('isReviewWork accepts all four kinds', () => {
  assert.equal(isReviewWork({ kind: 'prose', text: 'hello' }), true);
  assert.equal(isReviewWork({ kind: 'code-diff', diff: '--- a\n+++ b' }), true);
  assert.equal(isReviewWork({ kind: 'code-diff', diff: 'd', files: ['a.ts'] }), true);
  assert.equal(isReviewWork({ kind: 'plan', steps: ['step 1', 'step 2'] }), true);
  assert.equal(isReviewWork({ kind: 'payload', data: { x: 1 } }), true);
  assert.equal(isReviewWork({ kind: 'payload', data: {}, schema: { type: 'object' } }), true);
});

test('isReviewWork rejects malformed work', () => {
  assert.equal(isReviewWork({ kind: 'prose' }), false); // missing text
  assert.equal(isReviewWork({ kind: 'code-diff' }), false); // missing diff
  assert.equal(isReviewWork({ kind: 'plan', steps: [1, 2] }), false); // non-string steps
  assert.equal(isReviewWork({ kind: 'payload' }), false); // missing data
  assert.equal(isReviewWork({ kind: 'unknown' }), false);
  assert.equal(isReviewWork(null), false);
});

// ---- isReviewProvenance -----------------------------------------------------

test('isReviewProvenance accepts null foreign keys', () => {
  assert.equal(
    isReviewProvenance({ agentRunId: null, workItemId: null, workflowNodeId: null, dispatchedAt: 1 }),
    true,
  );
  assert.equal(
    isReviewProvenance({ agentRunId: 'r', workItemId: 'w', workflowNodeId: 'n', dispatchedAt: 2 }),
    true,
  );
});

test('isReviewProvenance rejects missing dispatchedAt', () => {
  assert.equal(
    isReviewProvenance({ agentRunId: null, workItemId: null, workflowNodeId: null }),
    false,
  );
});

// ---- isReviewAttempt --------------------------------------------------------

test('isReviewAttempt accepts full and minimal attempts', () => {
  assert.equal(isReviewAttempt({ attempt: 1, submittedAt: 1000 }), true);
  assert.equal(isReviewAttempt({ attempt: 2, submittedAt: 2000, decision: 'approved', feedback: null }), true);
  assert.equal(isReviewAttempt({ attempt: 2, submittedAt: 2000, decision: 'changes-requested', feedback: 'fix it' }), true);
});

test('isReviewAttempt rejects invalid decision', () => {
  assert.equal(isReviewAttempt({ attempt: 1, submittedAt: 1000, decision: 'yes' }), false);
});

// ---- isReviewPackage --------------------------------------------------------

test('isReviewPackage accepts all three producer types', () => {
  const works: ReviewWork[] = [
    { kind: 'prose', text: 'doc' },
    { kind: 'code-diff', diff: '@@' },
    { kind: 'plan', steps: ['a'] },
    { kind: 'payload', data: { k: 'v' } },
  ];

  const producers = ['agent-verification', 'workflow-gate', 'orchestrator-adhoc'] as const;
  for (const producer of producers) {
    for (const work of works) {
      const pkg = basePackage(work);
      assert.equal(isReviewPackage({ ...pkg, producer }), true, `producer=${producer} work=${work.kind}`);
    }
  }
});

test('isReviewPackage rejects missing/invalid fields', () => {
  const pkg = basePackage({ kind: 'prose', text: 'x' });
  assert.equal(isReviewPackage({ ...pkg, id: '' }), false);
  assert.equal(isReviewPackage({ ...pkg, producer: 'unknown' }), false);
  assert.equal(isReviewPackage({ ...pkg, owner: 'machine' }), false);
  assert.equal(isReviewPackage({ ...pkg, title: '' }), false);
  assert.equal(isReviewPackage({ ...pkg, work: { kind: 'prose' } }), false);
  assert.equal(isReviewPackage({ ...pkg, availableActions: ['approve', 'unknown-action'] }), false);
});

// ---- parseReviewPackage round-trip ------------------------------------------

test('parseReviewPackage round-trips agent-verification producer', () => {
  const pkg = basePackage({ kind: 'prose', text: 'here is my report' });
  const result = parseReviewPackage(pkg);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.producer, 'agent-verification');
    assert.equal(result.value.owner, 'human');
    assert.deepEqual(result.value.attemptHistory, []);
    assert.deepEqual(result.value.availableActions, ['approve', 'request-changes', 'discuss']);
  }
});

test('parseReviewPackage round-trips workflow-gate producer', () => {
  const pkg = makeReviewPackage({
    id: 'rp-2',
    producer: 'workflow-gate',
    owner: 'orchestrator',
    title: 'Orchestrator review',
    whatWasAsked: 'Verify the build',
    acceptanceCriteria: 'Tests pass',
    work: { kind: 'code-diff', diff: '--- /dev/null\n+++ b/x.ts', files: ['x.ts'] },
    provenance: { agentRunId: null, workItemId: null, workflowNodeId: 'node-5', dispatchedAt: 999 },
    attemptHistory: [
      { attempt: 1, submittedAt: 1001, decision: 'changes-requested', feedback: 'add tests' },
    ],
    availableActions: ['approve', 'request-changes', 'discuss'],
  });
  const result = parseReviewPackage(pkg);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.producer, 'workflow-gate');
    assert.equal(result.value.work.kind, 'code-diff');
    assert.equal(result.value.attemptHistory.length, 1);
    assert.equal(result.value.attemptHistory[0]?.decision, 'changes-requested');
  }
});

test('parseReviewPackage round-trips orchestrator-adhoc producer', () => {
  const pkg = makeReviewPackage({
    id: 'rp-3',
    producer: 'orchestrator-adhoc',
    owner: 'human',
    title: 'Please review this plan',
    whatWasAsked: 'Does the migration look safe?',
    acceptanceCriteria: 'No data loss',
    work: { kind: 'plan', steps: ['Backup', 'Migrate', 'Verify'] },
    provenance: { agentRunId: null, workItemId: 'wi-2', workflowNodeId: null, dispatchedAt: 2000 },
  });
  const result = parseReviewPackage(pkg);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.producer, 'orchestrator-adhoc');
    assert.equal(result.value.work.kind, 'plan');
  }
});

test('parseReviewPackage rejects invalid input', () => {
  assert.equal(parseReviewPackage(null).ok, false);
  assert.equal(parseReviewPackage({ id: 'x', producer: 'bad' }).ok, false);
  assert.equal(parseReviewPackage({ id: 'x', producer: 'workflow-gate', owner: 'bad' }).ok, false);
  assert.equal(
    parseReviewPackage({
      id: 'x', producer: 'workflow-gate', owner: 'human', title: 'T',
      whatWasAsked: 'Q', acceptanceCriteria: 'AC',
      work: { kind: 'prose', text: 'ok' },
      provenance: { agentRunId: null, workItemId: null, workflowNodeId: null, dispatchedAt: 1 },
      attemptHistory: [],
      availableActions: ['approve', 'bad-action'],
    }).ok,
    false,
  );
})

// ---- Decision-contract (pc-pty-chat-221) ------------------------------------

test('buildDecisionContract returns completed-work variant by default', () => {
  const dc = buildDecisionContract({ lifecyclePosition: 'completed-work' });
  assert.equal(dc.lifecyclePosition, 'completed-work');
  assert.ok(dc.approveEffect.length > 0, 'approveEffect must be non-empty');
  assert.ok(dc.rejectEffect.length > 0, 'rejectEffect must be non-empty');
  assert.ok(dc.verificationGuidance.length > 0, 'verificationGuidance must be non-empty');
});

test('buildDecisionContract completed-work with maxRounds embeds count', () => {
  const dc = buildDecisionContract({ lifecyclePosition: 'completed-work', maxRounds: 3 });
  assert.ok(dc.rejectEffect.includes('3'), 'rejectEffect must mention max rounds when specified');
});

test('buildDecisionContract completed-work with null maxRounds omits count', () => {
  const dc = buildDecisionContract({ lifecyclePosition: 'completed-work', maxRounds: null });
  assert.ok(!dc.rejectEffect.includes('max'), 'rejectEffect must not mention max when null');
});

test('buildDecisionContract plan-awaiting variant', () => {
  const dc = buildDecisionContract({ lifecyclePosition: 'plan-awaiting' });
  assert.equal(dc.lifecyclePosition, 'plan-awaiting');
  assert.ok(dc.approveEffect.length > 0);
  assert.ok(dc.rejectEffect.length > 0);
});

test('buildDecisionContract respects verificationGuidance override', () => {
  const dc = buildDecisionContract({
    lifecyclePosition: 'completed-work',
    verificationGuidance: 'Test it in your browser.',
  });
  assert.equal(dc.verificationGuidance, 'Test it in your browser.');
});

test('decisionContractHeaderText completed-work contains all four sections', () => {
  const dc = buildDecisionContract({ lifecyclePosition: 'completed-work' });
  const text = decisionContractHeaderText(dc);
  assert.ok(text.includes('✅'), 'header must start with completed-work emoji');
  assert.ok(text.includes('Work COMPLETE'), 'header must state lifecycle position');
  assert.ok(text.includes('Approve:'), 'header must include Approve effect');
  assert.ok(text.includes('Reject:'), 'header must include Reject effect');
  assert.ok(text.includes('Verification:'), 'header must include verification guidance');
});

test('decisionContractHeaderText plan-awaiting uses plan emoji', () => {
  const dc = buildDecisionContract({ lifecyclePosition: 'plan-awaiting' });
  const text = decisionContractHeaderText(dc);
  assert.ok(text.includes('📋'), 'plan-awaiting must use 📋 emoji');
  assert.ok(text.includes('Plan awaiting'), 'plan-awaiting must state lifecycle position');
});

test('isDecisionContract accepts valid decision contract', () => {
  const dc = buildDecisionContract({ lifecyclePosition: 'completed-work' });
  assert.equal(isDecisionContract(dc), true);
});

test('isDecisionContract rejects malformed objects', () => {
  assert.equal(isDecisionContract(null), false);
  assert.equal(isDecisionContract({}), false);
  assert.equal(isDecisionContract({ lifecyclePosition: 'unknown' }), false);
  assert.equal(
    isDecisionContract({
      lifecyclePosition: 'completed-work',
      approveEffect: 'ok',
      // missing rejectEffect and verificationGuidance
    }),
    false,
  );
});

test('makeReviewPackage with decisionContract round-trips through parseReviewPackage', () => {
  const dc = buildDecisionContract({ lifecyclePosition: 'completed-work', maxRounds: 3 });
  const pkg = makeReviewPackage({
    id: 'rp-dc-1',
    producer: 'agent-verification',
    owner: 'human',
    title: 'Review my work',
    whatWasAsked: 'Write a plan',
    acceptanceCriteria: '',
    work: { kind: 'prose', text: 'Done.' },
    provenance: {
      agentRunId: 'run-1',
      workItemId: 'wi-1',
      workflowNodeId: null,
      dispatchedAt: 1000,
    },
    decisionContract: dc,
  });
  // isReviewPackage must accept the new field
  assert.equal(isReviewPackage(pkg), true, 'isReviewPackage must accept decisionContract');
  // parseReviewPackage round-trips correctly
  const result = parseReviewPackage(pkg);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.decisionContract?.lifecyclePosition, 'completed-work');
    assert.ok(result.value.decisionContract?.rejectEffect.includes('3'), 'maxRounds preserved');
  }
});

test('makeReviewPackage without decisionContract still passes isReviewPackage (backward compat)', () => {
  const pkg = makeReviewPackage({
    id: 'rp-nodc',
    producer: 'workflow-gate',
    owner: 'orchestrator',
    title: 'Old envelope',
    whatWasAsked: 'Review this',
    acceptanceCriteria: '',
    work: { kind: 'prose', text: 'Summary.' },
    provenance: { agentRunId: null, workItemId: null, workflowNodeId: 'n1', dispatchedAt: 1 },
  });
  assert.equal(isReviewPackage(pkg), true);
  const result = parseReviewPackage(pkg);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.decisionContract, undefined);
  }
});

test('parseReviewPackage rejects invalid decisionContract field', () => {
  const pkg = makeReviewPackage({
    id: 'rp-bad-dc',
    producer: 'agent-verification',
    owner: 'human',
    title: 'T',
    whatWasAsked: 'Q',
    acceptanceCriteria: '',
    work: { kind: 'prose', text: 'x' },
    provenance: { agentRunId: null, workItemId: null, workflowNodeId: null, dispatchedAt: 1 },
  });
  const result = parseReviewPackage({ ...pkg, decisionContract: { lifecyclePosition: 'bad' } });
  assert.equal(result.ok, false, 'parseReviewPackage must reject invalid decisionContract');
});
