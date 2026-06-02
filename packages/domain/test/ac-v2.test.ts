// Slice 014a — v2 acceptance-criteria engine: new predicates, v2 derivation,
// v1 regression, and the verification-defect proof case at the unit level.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveAcceptanceCriteria,
  deriveAcceptanceCriteriaV2,
  evaluateAcceptance,
  KINDS_REQUIRING_EVIDENCE,
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
  const crit: AcceptanceCriteria = [{ kind: 'tool_called', name: 'pc_ask_user', min_count: 2 }];
  const enough = await evaluateAcceptance(
    crit,
    ctx({ toolCalls: [{ name: 'pc_ask_user' }, { name: 'x' }, { name: 'pc_ask_user' }] }),
    noExec,
  );
  assert.equal(enough.pass, true);
  const notEnough = await evaluateAcceptance(crit, ctx({ toolCalls: [{ name: 'pc_ask_user' }] }), noExec);
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

test('action derives tool_called (+ pending_ask_created for ask_user)', () => {
  const ask = deriveAcceptanceCriteriaV2({ kind: 'action', tool: 'pc_ask_user' });
  assert.deepEqual(ask, [{ kind: 'tool_called', name: 'pc_ask_user' }, { kind: 'pending_ask_created' }]);
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

test('prose store selects body vs report corpus; repo_file adds files_exist', () => {
  const body = deriveAcceptanceCriteriaV2({ kind: 'prose', sections: ['Goal'], store: 'work_item_body' });
  assert.deepEqual(body, [{ kind: 'body_contains', pattern: 'Goal' }]);
  const rep = deriveAcceptanceCriteriaV2({ kind: 'prose', sections: ['Goal'], store: 'attachment' });
  assert.deepEqual(rep, [{ kind: 'report_contains', pattern: 'Goal' }]);
  const onDisk = deriveAcceptanceCriteriaV2({ kind: 'prose', store: 'repo_file', path: 'docs/x.md' });
  assert.deepEqual(onDisk, [{ kind: 'files_exist', paths: ['docs/x.md'] }]);
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

test('PROOF CASE: an action contract whose tool was never called FAILS', async () => {
  // "your FIRST action MUST be pc_ask_user" → derive the evidence predicates.
  const crit = deriveAcceptanceCriteriaV2({ kind: 'action', tool: 'pc_ask_user' });
  // The agent echoed the instruction into the body but never called the tool
  // and no pending-ask landed.
  const result = await evaluateAcceptance(
    crit,
    ctx({ body: 'your FIRST action MUST be pc_ask_user', toolCalls: [], pendingAskCreated: false }),
    noExec,
  );
  assert.equal(result.pass, false);
  assert.equal(result.failures.length, 2); // tool_called + pending_ask_created both fail
});

// v1 derivation still works untouched (dispatch path until slice 019).
test('v1 deriveAcceptanceCriteria is unchanged', () => {
  assert.deepEqual(deriveAcceptanceCriteria({ kind: 'structured', fields: { a: 'string' } }), [
    { kind: 'fields_populated', keys: ['a'] },
  ]);
});
