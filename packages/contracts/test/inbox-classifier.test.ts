// pc-pty-chat-316: classifyInboxItem no longer carries humanVisible.
// Visibility is server-driven (addressKinds:['user-inbox'] on every inbox route).
// Tests here assert only `owner` and `actionable` — the two fields that remain.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyInboxItem, type InboxClassification } from '../src/index.ts';
import type { MailboxMessageKind } from '../src/index.ts';

// ---- Table-driven classifier tests ------------------------------------------

type Row = [MailboxMessageKind, string | undefined, Partial<InboxClassification>];

const table: Row[] = [
  // workflow-review: owner depends on flavor
  ['workflow-review', 'human',        { owner: 'human',        actionable: true  }],
  ['workflow-review', 'orchestrator', { owner: 'orchestrator', actionable: false }],
  ['workflow-review', undefined,      { owner: 'human',        actionable: true  }],

  // human-actionable kinds
  ['verification-review', undefined, { owner: 'human', actionable: true }],
  ['agent-ask-escalated', undefined, { owner: 'human', actionable: true }],

  // orchestrator-only; not actionable
  ['agent-question',          undefined, { owner: 'orchestrator', actionable: false }],
  ['agent-approval',          undefined, { owner: 'orchestrator', actionable: false }],
  ['agent-terminal',          undefined, { owner: 'orchestrator', actionable: false }],
  ['agent-stalled',           undefined, { owner: 'orchestrator', actionable: false }],
  ['workflow-run-failed',     undefined, { owner: 'orchestrator', actionable: false }],
  ['workflow-first-run-review', undefined, { owner: 'orchestrator', actionable: false }],
  ['system-notice',           undefined, { owner: 'orchestrator', actionable: false }],
  ['external-webhook',        undefined, { owner: 'orchestrator', actionable: false }],
  ['runtime-hook-ask',        undefined, { owner: 'orchestrator', actionable: false }],
];

for (const [kind, flavor, expected] of table) {
  const label = flavor ? `${kind}/${flavor}` : kind;
  test(`classifyInboxItem(${label}) => owner=${expected.owner} actionable=${expected.actionable}`, () => {
    const result = classifyInboxItem(kind, flavor as 'human' | 'orchestrator' | undefined);
    if (expected.owner !== undefined) assert.equal(result.owner, expected.owner, 'owner');
    if (expected.actionable !== undefined) assert.equal(result.actionable, expected.actionable, 'actionable');
  });
}

// ---- humanVisible is NOT on InboxClassification (pc-pty-chat-316) -----------

test('InboxClassification does not carry humanVisible (address is the single door)', () => {
  const c = classifyInboxItem('verification-review');
  assert.equal(
    Object.prototype.hasOwnProperty.call(c, 'humanVisible'),
    false,
    'humanVisible must be absent — visibility is server-driven, not kind-re-derived',
  );
});

// ---- Specific correctness checks --------------------------------------------

test('orchestrator-reviewer gate is NOT actionable', () => {
  const c = classifyInboxItem('workflow-review', 'orchestrator');
  assert.equal(c.owner, 'orchestrator');
  assert.equal(c.actionable, false);
});

test('human-reviewer gate IS actionable', () => {
  const c = classifyInboxItem('workflow-review', 'human');
  assert.equal(c.owner, 'human');
  assert.equal(c.actionable, true);
});

test('raw agent-question is orchestrator-owned and not actionable', () => {
  const c = classifyInboxItem('agent-question');
  assert.equal(c.owner, 'orchestrator');
  assert.equal(c.actionable, false);
});

test('escalated ask is human-owned and actionable', () => {
  const c = classifyInboxItem('agent-ask-escalated');
  assert.equal(c.owner, 'human');
  assert.equal(c.actionable, true);
});
