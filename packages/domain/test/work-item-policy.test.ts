// Slice 019 (Decision 4) — WI-requirement policy: deterministic per kind.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { expectedOutputRequiresWorkItem } from '../src/index.ts';
import type { ExpectedOutput } from '../src/contract.ts';

test('contract-home kinds require no work item', () => {
  const noHome: ExpectedOutput[] = [
    { kind: 'answer' },
    { kind: 'payload', schema: { type: 'object' } },
    { kind: 'action', tool: 'pc_ask_user' },
    { kind: 'external', system: 'email', action: 'send', confirm: 'always', idempotency_key: 'k' },
    { kind: 'binary' },
  ];
  for (const spec of noHome) {
    assert.equal(expectedOutputRequiresWorkItem(spec), false, `${spec.kind} should not require a WI`);
  }
});

test('repo requires a work item (lean)', () => {
  assert.equal(expectedOutputRequiresWorkItem({ kind: 'repo', isolation: 'worktree' }), true);
});

test('prose requires a WI unless explicitly contract-stored', () => {
  assert.equal(expectedOutputRequiresWorkItem({ kind: 'prose', store: 'contract' }), false);
  assert.equal(expectedOutputRequiresWorkItem({ kind: 'prose', store: 'work_item_body' }), true);
  assert.equal(expectedOutputRequiresWorkItem({ kind: 'prose', store: 'attachment' }), true);
  assert.equal(expectedOutputRequiresWorkItem({ kind: 'prose', store: 'repo_file', path: 'x.md' }), true);
  // unset store defaults to requiring a WI (default store is work_item_body/attachment)
  assert.equal(expectedOutputRequiresWorkItem({ kind: 'prose' }), true);
});
