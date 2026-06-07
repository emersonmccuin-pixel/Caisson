import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyInboxItem, type InboxClassification } from '../src/index.ts';
import type { MailboxMessageKind } from '../src/index.ts';

// ---- Table-driven classifier tests ------------------------------------------

type Row = [MailboxMessageKind, string | undefined, Partial<InboxClassification>];

const table: Row[] = [
  // workflow-review: owner depends on flavor
  ['workflow-review', 'human', { owner: 'human', humanVisible: true, actionable: true }],
  ['workflow-review', 'orchestrator', { owner: 'orchestrator', humanVisible: false, actionable: false }],
  ['workflow-review', undefined, { owner: 'human', humanVisible: true, actionable: true }],

  // human-actionable kinds
  ['verification-review', undefined, { owner: 'human', humanVisible: true, actionable: true }],
  ['agent-ask-escalated', undefined, { owner: 'human', humanVisible: true, actionable: true }],

  // orchestrator-only; not human-visible
  ['agent-question', undefined, { owner: 'orchestrator', humanVisible: false, actionable: false }],
  ['agent-approval', undefined, { owner: 'orchestrator', humanVisible: false, actionable: false }],
  ['agent-terminal', undefined, { owner: 'orchestrator', humanVisible: false, actionable: false }],
  ['agent-stalled', undefined, { owner: 'orchestrator', humanVisible: false, actionable: false }],

  // info-only / not actionable
  ['workflow-run-failed', undefined, { owner: 'orchestrator', humanVisible: false, actionable: false }],
  ['workflow-first-run-review', undefined, { owner: 'orchestrator', humanVisible: false, actionable: false }],
  ['system-notice', undefined, { owner: 'orchestrator', humanVisible: false, actionable: false }],
  ['external-webhook', undefined, { owner: 'orchestrator', humanVisible: false, actionable: false }],
  ['runtime-hook-ask', undefined, { owner: 'orchestrator', humanVisible: false, actionable: false }],
];

for (const [kind, flavor, expected] of table) {
  const label = flavor ? `${kind}/${flavor}` : kind;
  test(`classifyInboxItem(${label}) => owner=${expected.owner} humanVisible=${expected.humanVisible} actionable=${expected.actionable}`, () => {
    const result = classifyInboxItem(kind, flavor as 'human' | 'orchestrator' | undefined);
    if (expected.owner !== undefined) assert.equal(result.owner, expected.owner, 'owner');
    if (expected.humanVisible !== undefined) assert.equal(result.humanVisible, expected.humanVisible, 'humanVisible');
    if (expected.actionable !== undefined) assert.equal(result.actionable, expected.actionable, 'actionable');
  });
}

// ---- Cross-check: humanVisible and actionable are consistent ----------------

test('humanVisible=false always implies actionable=false', () => {
  const allKinds: MailboxMessageKind[] = [
    'agent-question', 'agent-approval', 'agent-terminal', 'agent-stalled',
    'workflow-review', 'verification-review', 'workflow-run-failed',
    'workflow-first-run-review', 'external-webhook', 'runtime-hook-ask',
    'system-notice', 'agent-ask-escalated',
  ];
  for (const kind of allKinds) {
    const c = classifyInboxItem(kind);
    if (!c.humanVisible) {
      assert.equal(c.actionable, false, `kind=${kind}: humanVisible=false but actionable=true`);
    }
  }
});

test('orchestrator-reviewer gate is not human-visible', () => {
  const c = classifyInboxItem('workflow-review', 'orchestrator');
  assert.equal(c.humanVisible, false);
  assert.equal(c.actionable, false);
});

test('human-reviewer gate is human-visible and actionable', () => {
  const c = classifyInboxItem('workflow-review', 'human');
  assert.equal(c.humanVisible, true);
  assert.equal(c.actionable, true);
});

test('raw agent-question is not human-visible', () => {
  const c = classifyInboxItem('agent-question');
  assert.equal(c.humanVisible, false);
  assert.equal(c.actionable, false);
});

test('escalated ask is human-visible and actionable', () => {
  const c = classifyInboxItem('agent-ask-escalated');
  assert.equal(c.humanVisible, true);
  assert.equal(c.actionable, true);
});
