// Guardrail (Slice 2, Principle 1): derivation must never emit a decidable
// syntactic predicate to stand in for a judgment criterion. This test fences
// the must_address→report_contains and sections→body_contains/report_contains
// auto-emit paths so they cannot be quietly reintroduced.
//
// References: verification-soundness-decision-2026-06-10, pc-pty-chat-371.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveAcceptanceCriteriaV2 } from '../src/ac-derivation.ts';

// ── Soundness: semantic-intent fields MUST NOT compile to syntactic predicates ──

test('answer.must_address derives ZERO report_contains predicates', () => {
  const crit = deriveAcceptanceCriteriaV2({ kind: 'answer', must_address: ['risk', 'cost', 'timeline'] });
  const bad = crit.filter((p) => p.kind === 'report_contains' || p.kind === 'body_contains');
  assert.equal(
    bad.length,
    0,
    `must_address MUST NOT emit report_contains/body_contains; got ${JSON.stringify(bad)}`,
  );
});

test('prose.sections derives ZERO report_contains predicates (store: contract)', () => {
  const crit = deriveAcceptanceCriteriaV2({ kind: 'prose', sections: ['Summary', 'Goals'], store: 'contract' });
  const bad = crit.filter((p) => p.kind === 'report_contains' || p.kind === 'body_contains');
  assert.equal(
    bad.length,
    0,
    `sections (store:contract) MUST NOT emit report_contains/body_contains; got ${JSON.stringify(bad)}`,
  );
});

test('prose.sections derives ZERO body_contains predicates (store: attachment)', () => {
  const crit = deriveAcceptanceCriteriaV2({ kind: 'prose', sections: ['Summary', 'Goals'], store: 'attachment' });
  const bad = crit.filter((p) => p.kind === 'report_contains' || p.kind === 'body_contains');
  assert.equal(
    bad.length,
    0,
    `sections (store:attachment) MUST NOT emit body_contains/report_contains; got ${JSON.stringify(bad)}`,
  );
});

// ── Structural predicates STILL derive (unaffected by this change) ──

test('answer.min_chars still derives min_length', () => {
  const crit = deriveAcceptanceCriteriaV2({ kind: 'answer', min_chars: 200 });
  const minLen = crit.filter((p) => p.kind === 'min_length');
  assert.equal(minLen.length, 1, 'answer.min_chars must still derive min_length');
  assert.deepEqual(minLen[0], { kind: 'min_length', min: 200 });
});

test('prose.min_chars still derives min_length', () => {
  const crit = deriveAcceptanceCriteriaV2({ kind: 'prose', min_chars: 500 });
  const minLen = crit.filter((p) => p.kind === 'min_length');
  assert.equal(minLen.length, 1, 'prose.min_chars must still derive min_length');
  assert.deepEqual(minLen[0], { kind: 'min_length', min: 500 });
});

test('prose.store:attachment still derives attachments_present', () => {
  const crit = deriveAcceptanceCriteriaV2({ kind: 'prose', store: 'attachment' });
  const ap = crit.filter((p) => p.kind === 'attachments_present');
  assert.equal(ap.length, 1, 'store:attachment must still derive attachments_present');
});

test('prose.store:repo_file still derives files_exist', () => {
  const crit = deriveAcceptanceCriteriaV2({ kind: 'prose', store: 'repo_file', path: 'docs/out.md' });
  const fe = crit.filter((p) => p.kind === 'files_exist');
  assert.equal(fe.length, 1, 'store:repo_file must still derive files_exist');
});

// ── Honest empty decidable set: semantic-only contracts now derive [] ──

test('prose with sections-only derives empty predicates (no auto-fail on substring)', () => {
  // A prose contract whose ONLY criteria are semantic (sections) now derives an
  // empty decidable set. This is the CORRECT outcome — semantic criteria are
  // agent guidance, not machine predicates. Without min_chars or structural
  // store, prose trusts the structural capture (empty AC → auto-accept).
  const crit = deriveAcceptanceCriteriaV2({ kind: 'prose', sections: ['Introduction', 'Findings'] });
  assert.deepEqual(
    crit,
    [],
    'prose+sections-only (no store, no min_chars) must derive empty AC, not a substring predicate',
  );
});

test('answer with must_address-only derives empty predicates', () => {
  const crit = deriveAcceptanceCriteriaV2({ kind: 'answer', must_address: ['cost', 'timeline'] });
  assert.deepEqual(crit, [], 'answer+must_address-only (no min_chars) must derive empty AC');
});

test('prose attachment + sections derives only attachments_present (no body_contains)', () => {
  // With sections removed from auto-emit, attachment store derives just the
  // structural capture proof — no substring scan.
  const crit = deriveAcceptanceCriteriaV2({
    kind: 'prose',
    sections: ['Summary', 'Plan'],
    store: 'attachment',
    doc_type: 'plan',
  });
  assert.deepEqual(
    crit,
    [{ kind: 'attachments_present', names: ['plan.md'] }],
    'prose+sections+attachment must derive ONLY attachments_present, not body_contains',
  );
});
