// Drift guard: packages/domain/src/contract.ts is the canonical contract-v2
// union; packages/contracts/src/contracts.ts is a byte-equivalent hand-copy
// (the browser mirror — @pc/domain pulls native deps the web bundle avoids).
// The import-boundary test (packages/contracts/test/import-boundary.test.ts)
// forbids any @pc/domain import inside packages/contracts/src, so this parity
// test must live in apps/server — the one package that already depends on
// BOTH @pc/domain and @pc/contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Domain from '@pc/domain';
import * as Contracts from '@pc/contracts';

test('VERIFICATION_TIERS parity', () => {
  assert.deepEqual(
    [...Domain.VERIFICATION_TIERS],
    [...Contracts.VERIFICATION_TIERS],
    'VERIFICATION_TIERS drifted between @pc/domain and @pc/contracts',
  );
});

test('VERIFICATION_STATUSES parity', () => {
  assert.deepEqual(
    [...Domain.VERIFICATION_STATUSES],
    [...Contracts.VERIFICATION_STATUSES],
    'VERIFICATION_STATUSES drifted between @pc/domain and @pc/contracts',
  );
});

test('DELIVERABLE_KINDS parity', () => {
  assert.deepEqual(
    [...Domain.DELIVERABLE_KINDS],
    [...Contracts.DELIVERABLE_KINDS],
    'DELIVERABLE_KINDS drifted between @pc/domain and @pc/contracts',
  );
});

test('EXPECTED_OUTPUT_KINDS parity', () => {
  assert.deepEqual(
    [...Domain.EXPECTED_OUTPUT_KINDS],
    [...Contracts.EXPECTED_OUTPUT_KINDS],
    'EXPECTED_OUTPUT_KINDS drifted between @pc/domain and @pc/contracts',
  );
});

test('CONTRACT_STATUSES parity', () => {
  assert.deepEqual(
    [...Domain.CONTRACT_STATUSES],
    [...Contracts.CONTRACT_STATUSES],
    'CONTRACT_STATUSES drifted between @pc/domain and @pc/contracts',
  );
});

test('EXTERNAL_SYSTEMS parity', () => {
  // @pc/domain only namespaces EXTERNAL_SYSTEMS (not top-level re-exported);
  // @pc/contracts exports it top-level.
  assert.deepEqual(
    [...Domain.ContractV2.EXTERNAL_SYSTEMS],
    [...Contracts.EXTERNAL_SYSTEMS],
    'EXTERNAL_SYSTEMS drifted between @pc/domain and @pc/contracts',
  );
});

test('ACCEPTANCE_PREDICATE_KINDS invariant (14 members)', () => {
  // @pc/contracts only exposes the AcceptancePredicate UNION (type-only,
  // erased at runtime) — there is NO value array to compare against. Pin the
  // domain-side value list so adding a predicate without updating the
  // contracts mirror trips here.
  assert.equal(Domain.ACCEPTANCE_PREDICATE_KINDS.length, 14);
  assert.deepEqual(
    [...Domain.ACCEPTANCE_PREDICATE_KINDS],
    [
      'files_exist',
      'fields_populated',
      'field_matches',
      'bash_exit_zero',
      'attachments_present',
      'body_contains',
      'child_work_items_done',
      'schema_valid',
      'git_diff_nonempty',
      'external_handle_present',
      'tool_called',
      'pending_ask_created',
      'report_contains',
      'min_length',
    ],
    'ACCEPTANCE_PREDICATE_KINDS changed — update the @pc/contracts AcceptancePredicate union mirror',
  );
});
