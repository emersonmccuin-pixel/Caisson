// Slice 014a — v2 acceptance-criteria engine: new predicates, v2 derivation,
// v1 regression, and the verification-defect proof case at the unit level.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveAcceptanceCriteriaV2,
  evaluateAcceptance,
  KINDS_REQUIRING_EVIDENCE,
  getPodDefaultExpectedOutput,
  type EvaluationContext,
  type PredicateExecutors,
} from '../src/index.ts';
import type { AcceptanceCriteria } from '../src/contract.ts';

function ctx(over: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    body: '',
    fields: {},
    attachments: [],
    childWorkItems: [],
    report: '',
    toolCalls: [],
    pendingAskCreated: false,
    ...over,
  };
}

const noExec: PredicateExecutors = {
  fileSize: async () => null,
  runBash: async () => 1,
};

// ── new predicates ──────────────────────────────────────────────────────────

test('report_contains reads the report, not the body', async () => {
  const crit: AcceptanceCriteria = [{ kind: 'report_contains', pattern: 'Summary' }];
  const hit = await evaluateAcceptance(crit, ctx({ report: '## Summary\n…', body: '' }), noExec);
  assert.equal(hit.pass, true);
  // Same needle only in the BODY must NOT satisfy a report check.
  const miss = await evaluateAcceptance(crit, ctx({ report: '', body: '## Summary' }), noExec);
  assert.equal(miss.pass, false);
});

test('tool_called passes only when the tool appears enough times', async () => {
  const crit: AcceptanceCriteria = [{ kind: 'tool_called', name: 'pc_ask_orchestrator', min_count: 2 }];
  const enough = await evaluateAcceptance(
    crit,
    ctx({ toolCalls: [{ name: 'pc_ask_orchestrator' }, { name: 'x' }, { name: 'pc_ask_orchestrator' }] }),
    noExec,
  );
  assert.equal(enough.pass, true);
  const notEnough = await evaluateAcceptance(crit, ctx({ toolCalls: [{ name: 'pc_ask_orchestrator' }] }), noExec);
  assert.equal(notEnough.pass, false);
});

test('pending_ask_created reflects the durable side-effect', async () => {
  const crit: AcceptanceCriteria = [{ kind: 'pending_ask_created' }];
  assert.equal((await evaluateAcceptance(crit, ctx({ pendingAskCreated: true }), noExec)).pass, true);
  assert.equal((await evaluateAcceptance(crit, ctx({ pendingAskCreated: false }), noExec)).pass, false);
});

test('external_handle_present requires a non-empty handle', async () => {
  const crit: AcceptanceCriteria = [{ kind: 'external_handle_present' }];
  assert.equal((await evaluateAcceptance(crit, ctx({ externalHandle: 'msg_123' }), noExec)).pass, true);
  assert.equal((await evaluateAcceptance(crit, ctx({ externalHandle: '' }), noExec)).pass, false);
  assert.equal((await evaluateAcceptance(crit, ctx({ externalHandle: null }), noExec)).pass, false);
});

test('schema_valid validates the payload against the JsonSchema subset', async () => {
  const crit: AcceptanceCriteria = [
    {
      kind: 'schema_valid',
      schema: {
        type: 'object',
        required: ['verdict', 'score'],
        properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, score: { type: 'number' } },
      },
    },
  ];
  assert.equal(
    (await evaluateAcceptance(crit, ctx({ payload: { verdict: 'pass', score: 0.9 } }), noExec)).pass,
    true,
  );
  // missing required field
  assert.equal((await evaluateAcceptance(crit, ctx({ payload: { verdict: 'pass' } }), noExec)).pass, false);
  // enum violation
  assert.equal(
    (await evaluateAcceptance(crit, ctx({ payload: { verdict: 'maybe', score: 1 } }), noExec)).pass,
    false,
  );
  // wrong type
  assert.equal(
    (await evaluateAcceptance(crit, ctx({ payload: { verdict: 'pass', score: 'high' } }), noExec)).pass,
    false,
  );
  // no payload at all
  assert.equal((await evaluateAcceptance(crit, ctx({ payload: undefined }), noExec)).pass, false);
});

test('git_diff_nonempty uses the executor; fails closed when absent', async () => {
  const crit: AcceptanceCriteria = [{ kind: 'git_diff_nonempty', cwd: 'worktree' }];
  const withDiff: PredicateExecutors = { ...noExec, hasGitDiff: async () => true };
  const noDiff: PredicateExecutors = { ...noExec, hasGitDiff: async () => false };
  assert.equal((await evaluateAcceptance(crit, ctx(), withDiff)).pass, true);
  assert.equal((await evaluateAcceptance(crit, ctx(), noDiff)).pass, false);
  // no executor → fail with a clear reason
  const noGit = await evaluateAcceptance(crit, ctx(), noExec);
  assert.equal(noGit.pass, false);
  assert.match(noGit.failures[0]!.reason, /no git executor/);
});

// ── v1 regression (superset must not change v1 behavior) ────────────────────

test('v1 predicates still evaluate identically', async () => {
  const crit: AcceptanceCriteria = [
    { kind: 'body_contains', pattern: 'findings' },
    { kind: 'fields_populated', keys: ['author'] },
  ];
  const pass = await evaluateAcceptance(
    crit,
    ctx({ body: 'the findings are…', fields: { author: 'x' } }),
    noExec,
  );
  assert.equal(pass.pass, true);
  const fail = await evaluateAcceptance(crit, ctx({ body: 'nothing', fields: {} }), noExec);
  assert.equal(fail.pass, false);
  assert.equal(fail.failures.length, 2);
});

// ── v2 derivation ───────────────────────────────────────────────────────────

test('action derives tool_called (+ pending_ask_created for the ask tools)', () => {
  // M7 (FD-6): pc_ask_user ☠ — the surviving ask doors both leave a durable row.
  const ask = deriveAcceptanceCriteriaV2({ kind: 'action', tool: 'pc_ask_orchestrator' });
  assert.deepEqual(ask, [{ kind: 'tool_called', name: 'pc_ask_orchestrator' }, { kind: 'pending_ask_created' }]);
  const approval = deriveAcceptanceCriteriaV2({ kind: 'action', tool: 'pc_request_approval' });
  assert.deepEqual(approval, [{ kind: 'tool_called', name: 'pc_request_approval' }, { kind: 'pending_ask_created' }]);
  const other = deriveAcceptanceCriteriaV2({ kind: 'action', tool: 'pc_create_work_item', min_count: 3 });
  assert.deepEqual(other, [{ kind: 'tool_called', name: 'pc_create_work_item', min_count: 3 }]);
});

test('payload derives schema_valid; answer derives report_contains', () => {
  const schema = { type: 'object' as const };
  assert.deepEqual(deriveAcceptanceCriteriaV2({ kind: 'payload', schema }), [
    { kind: 'schema_valid', schema },
  ]);
  assert.deepEqual(
    deriveAcceptanceCriteriaV2({ kind: 'answer', must_address: ['risk', 'cost'] }),
    [
      { kind: 'report_contains', pattern: 'risk' },
      { kind: 'report_contains', pattern: 'cost' },
    ],
  );
});

test('prose AC source tracks the store (014c; M5 — ☠ work_item_body)', () => {
  // attachment → asserts the doc landed (by name) AND searches the body+
  // attachment corpus (body_contains spans both). Default name: deliverable.md.
  assert.deepEqual(
    deriveAcceptanceCriteriaV2({ kind: 'prose', sections: ['Goal'], store: 'attachment' }),
    [{ kind: 'attachments_present', names: ['deliverable.md'] }, { kind: 'body_contains', pattern: 'Goal' }],
  );
  // attachment with a doc_type → <doc_type>.md.
  assert.deepEqual(
    deriveAcceptanceCriteriaV2({ kind: 'prose', sections: ['Goal'], store: 'attachment', doc_type: 'spec' }),
    [{ kind: 'attachments_present', names: ['spec.md'] }, { kind: 'body_contains', pattern: 'Goal' }],
  );
  // contract → the contract report corpus.
  assert.deepEqual(
    deriveAcceptanceCriteriaV2({ kind: 'prose', sections: ['Goal'], store: 'contract' }),
    [{ kind: 'report_contains', pattern: 'Goal' }],
  );
  // repo_file → the file must exist + be non-trivial (min_chars → min_size_bytes,
  // default 1). Section text isn't loaded from disk, so no content predicate.
  assert.deepEqual(
    deriveAcceptanceCriteriaV2({ kind: 'prose', store: 'repo_file', path: 'docs/x.md' }),
    [{ kind: 'files_exist', paths: ['docs/x.md'], min_size_bytes: 1 }],
  );
  assert.deepEqual(
    deriveAcceptanceCriteriaV2({ kind: 'prose', store: 'repo_file', path: 'docs/x.md', min_chars: 1200 }),
    [{ kind: 'files_exist', paths: ['docs/x.md'], min_size_bytes: 1200 }],
  );
});

test('repo derives git_diff_nonempty + bash checks; external derives handle', () => {
  const repo = deriveAcceptanceCriteriaV2({
    kind: 'repo',
    isolation: 'worktree',
    checks: [{ preset: 'test' }, { command: 'echo ok' }],
  });
  assert.deepEqual(repo, [
    { kind: 'git_diff_nonempty', cwd: 'worktree' },
    { kind: 'bash_exit_zero', command: 'pnpm test', cwd: 'worktree' },
    { kind: 'bash_exit_zero', command: 'echo ok', cwd: 'worktree' },
  ]);
  assert.deepEqual(deriveAcceptanceCriteriaV2({ kind: 'external', system: 'email', action: 'send', confirm: 'always', idempotency_key: 'k' }), [
    { kind: 'external_handle_present' },
  ]);
  assert.deepEqual(deriveAcceptanceCriteriaV2({ kind: 'binary' }), []);
});

test('KINDS_REQUIRING_EVIDENCE is the side-effect set for fail-closed', () => {
  assert.deepEqual([...KINDS_REQUIRING_EVIDENCE].sort(), ['action', 'external', 'repo']);
});

// ── the verification-defect proof case (unit level) ─────────────────────────

// ── bug regressions ─────────────────────────────────────────────────────────

test('body_contains (277 fix): normalizes whitespace — "a / b" matches "a/b" pattern', async () => {
  const crit: AcceptanceCriteria = [{ kind: 'body_contains', pattern: 'Where 228/267/270 each land' }];
  // Document wrote the heading with spaces around the slashes
  const hit = await evaluateAcceptance(
    crit,
    ctx({ body: '## Where 228 / 267 / 270 each land\n\nDetails…' }),
    noExec,
  );
  assert.equal(hit.pass, true, 'whitespace-normalized match must pass');
});

test('body_contains (277 fix): case-insensitive — "Goal" matches "goal" in body', async () => {
  const crit: AcceptanceCriteria = [{ kind: 'body_contains', pattern: 'Implementation Plan' }];
  const hit = await evaluateAcceptance(crit, ctx({ body: '## implementation plan\n\nDetails…' }), noExec);
  assert.equal(hit.pass, true, 'case-insensitive match must pass');
});

test('body_contains (277 fix): regex path is NOT normalized (exact control preserved)', async () => {
  const crit: AcceptanceCriteria = [{ kind: 'body_contains', pattern: '^hello$', regex: true }];
  const miss = await evaluateAcceptance(crit, ctx({ body: 'HELLO' }), noExec);
  assert.equal(miss.pass, false, 'regex path must remain case-sensitive');
  const hit = await evaluateAcceptance(crit, ctx({ body: 'hello' }), noExec);
  assert.equal(hit.pass, true);
});

test('repo checks as plain strings (279 fix): normalize to command shape, no throw', () => {
  // Plain string checks must not 500 with "'preset' in <string>"
  const result = deriveAcceptanceCriteriaV2({
    kind: 'repo',
    isolation: 'worktree',
    checks: ['pnpm --filter @pc/contracts typecheck', 'pnpm -r typecheck'] as never,
  });
  assert.deepEqual(result, [
    { kind: 'git_diff_nonempty', cwd: 'worktree' },
    { kind: 'bash_exit_zero', command: 'pnpm --filter @pc/contracts typecheck', cwd: 'worktree' },
    { kind: 'bash_exit_zero', command: 'pnpm -r typecheck', cwd: 'worktree' },
  ]);
});

// ── 265.1 false-fail fixes ───────────────────────────────────────────────────

test('(265.1-a) report_contains is case-insensitive in the deliverable corpus', async () => {
  // Pattern uses uppercase "Summary"; deliverable text uses "## summary".
  const crit: AcceptanceCriteria = [{ kind: 'report_contains', pattern: 'Summary' }];
  // In report (mixed case) → passes
  const inReport = await evaluateAcceptance(
    crit,
    ctx({ report: '## summary of the plan', deliverableText: '' }),
    noExec,
  );
  assert.equal(inReport.pass, true, 'case-insensitive match in report must pass');
  // In deliverableText (lower) → passes
  const inDeliverable = await evaluateAcceptance(
    crit,
    ctx({ report: '', deliverableText: '## summary\nDetails here.' }),
    noExec,
  );
  assert.equal(inDeliverable.pass, true, 'case-insensitive match in deliverableText must pass');
  // Neither → fails
  const nowhere = await evaluateAcceptance(
    crit,
    ctx({ report: '', deliverableText: 'No such heading here.' }),
    noExec,
  );
  assert.equal(nowhere.pass, false);
});

test('(265.1-b) report_contains searches deliverable text + attachments, not just the report', async () => {
  // Token lives only in an attachment — differently-worded report must still pass.
  const crit: AcceptanceCriteria = [{ kind: 'report_contains', pattern: 'findings' }];
  const inAttachment = await evaluateAcceptance(
    crit,
    ctx({
      report: 'Done — see the attached document.',
      deliverableText: '',
      attachments: [{ name: 'report.md', content: '## Key findings\nAll went well.' }],
    }),
    noExec,
  );
  assert.equal(inAttachment.pass, true, 'token in attachment must pass report_contains');

  // Token in deliverableText only (no report, no attachment) → passes.
  const inDeliverableOnly = await evaluateAcceptance(
    crit,
    ctx({ report: '', deliverableText: 'Here are the key findings from the research.' }),
    noExec,
  );
  assert.equal(inDeliverableOnly.pass, true, 'token in deliverableText must pass');

  // Token only in the WI body → must NOT satisfy report_contains.
  const inBodyOnly = await evaluateAcceptance(
    crit,
    ctx({ body: 'Task: summarize findings', report: '', deliverableText: '' }),
    noExec,
  );
  assert.equal(inBodyOnly.pass, false, 'body-only token must not satisfy report_contains');
});

test('(265.1-c) min_chars passes on DELIVERABLE length; short report does not false-fail', async () => {
  // A 1000-char deliverable with a 10-char report must pass min_chars: 200.
  const longDeliverable = 'x'.repeat(1000);
  const crit: AcceptanceCriteria = [{ kind: 'min_length', min: 200 }];

  const longDelShortReport = await evaluateAcceptance(
    crit,
    ctx({ report: 'Done.', deliverableText: longDeliverable }),
    noExec,
  );
  assert.equal(longDelShortReport.pass, true, 'long deliverable + short report must pass min_length');

  // Short deliverable fails even if the report is long.
  const shortDel = await evaluateAcceptance(
    crit,
    ctx({ report: 'x'.repeat(1000), deliverableText: 'short' }),
    noExec,
  );
  assert.equal(shortDel.pass, false, 'short deliverable + long report must fail min_length');

  // store: contract and store: attachment both derive { kind: 'min_length' }.
  const contractDerived = deriveAcceptanceCriteriaV2({ kind: 'prose', store: 'contract', min_chars: 200 });
  const attachmentDerived = deriveAcceptanceCriteriaV2({ kind: 'prose', store: 'attachment', min_chars: 200 });
  // Both include exactly one min_length predicate with min: 200.
  const contractMinLen = contractDerived.filter((p) => p.kind === 'min_length');
  const attachmentMinLen = attachmentDerived.filter((p) => p.kind === 'min_length');
  assert.equal(contractMinLen.length, 1, 'store:contract must derive one min_length predicate');
  assert.equal(attachmentMinLen.length, 1, 'store:attachment must derive one min_length predicate');
  assert.deepEqual(contractMinLen[0], { kind: 'min_length', min: 200 });
  assert.deepEqual(attachmentMinLen[0], { kind: 'min_length', min: 200 });

  // answer also derives min_length, not a report_contains regex.
  const answerDerived = deriveAcceptanceCriteriaV2({ kind: 'answer', min_chars: 100 });
  assert.deepEqual(answerDerived, [{ kind: 'min_length', min: 100 }]);
});

test('(265.1-d) planner default derives min_length (not literal tokens); valid plan passes', async () => {
  const plannerSpec = getPodDefaultExpectedOutput('planner');
  assert.ok(plannerSpec, 'planner must have a default expected output');
  // No literal-token must_address fields on the planner default.
  assert.ok(
    !('must_address' in plannerSpec) ||
      !(plannerSpec as { must_address?: string[] }).must_address?.length,
    'planner must not use must_address (brittle literal-token match)',
  );
  // Derived AC is a single min_length check.
  const ac = deriveAcceptanceCriteriaV2(plannerSpec);
  assert.equal(ac.length, 1);
  assert.equal(ac[0]!.kind, 'min_length');

  // A valid 200+-char plan text passes.
  const validPlan = 'Step 1: analyze the requirements.\n' + 'Step 2: design the solution.\n'.repeat(10);
  const crit: AcceptanceCriteria = ac;
  const pass = await evaluateAcceptance(
    crit,
    ctx({ deliverableText: validPlan }),
    noExec,
  );
  assert.equal(pass.pass, true, 'a valid plan of sufficient length must pass planner AC');

  // An empty deliverable fails.
  const empty = await evaluateAcceptance(crit, ctx({ deliverableText: '' }), noExec);
  assert.equal(empty.pass, false, 'empty plan must fail planner AC');
});

test('PROOF CASE: an action contract whose tool was never called FAILS', async () => {
  // "your FIRST action MUST be pc_ask_orchestrator" → derive the evidence predicates.
  const crit = deriveAcceptanceCriteriaV2({ kind: 'action', tool: 'pc_ask_orchestrator' });
  // The agent echoed the instruction into the body but never called the tool
  // and no pending-ask landed.
  const result = await evaluateAcceptance(
    crit,
    ctx({ body: 'your FIRST action MUST be pc_ask_orchestrator', toolCalls: [], pendingAskCreated: false }),
    noExec,
  );
  assert.equal(result.pass, false);
  assert.equal(result.failures.length, 2); // tool_called + pending_ask_created both fail
});
