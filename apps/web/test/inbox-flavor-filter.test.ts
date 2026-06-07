// pc-pty-chat-267 — classifier-based inbox filter.
// Tests the readReviewFlavor extractor and isInboxItemHumanVisible against the
// REAL exported module — not a re-implemented copy — so a rename or signature
// break fails here immediately.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readReviewFlavor, isInboxItemHumanVisible } from '../src/features/mailbox/MailboxInbox.tsx';
import type { MailboxInboxItem } from '../src/features/mailbox/types.ts';

function makeItem(kind: MailboxInboxItem['message']['kind'], payload: Record<string, unknown> = {}): MailboxInboxItem {
  return {
    recipient: {
      id: 'r1' as MailboxInboxItem['recipient']['id'],
      messageId: 'm1' as MailboxInboxItem['recipient']['messageId'],
      address: { kind: 'user-inbox', userId: 'local-user', projectId: 'p1' },
      readAt: null,
      actionedAt: null,
      dismissedAt: null,
    },
    message: {
      id: 'm1' as MailboxInboxItem['message']['id'],
      projectId: 'p1' as MailboxInboxItem['message']['projectId'],
      kind,
      subject: null,
      body: 'test',
      payload,
      source: { kind: 'system', id: null },
      idempotencyKey: 'k1',
      createdAt: 0,
      updatedAt: 0,
    },
  };
}

// ── readReviewFlavor ──────────────────────────────────────────────────────────

test('readReviewFlavor returns "human" when payload.flavor is "human"', () => {
  const item = makeItem('workflow-review', { flavor: 'human' });
  assert.equal(readReviewFlavor(item.message), 'human');
});

test('readReviewFlavor returns "orchestrator" when payload.flavor is "orchestrator"', () => {
  const item = makeItem('workflow-review', { flavor: 'orchestrator' });
  assert.equal(readReviewFlavor(item.message), 'orchestrator');
});

test('readReviewFlavor returns undefined when payload has no flavor', () => {
  const item = makeItem('workflow-review', {});
  assert.equal(readReviewFlavor(item.message), undefined);
});

test('readReviewFlavor returns undefined for unexpected flavor value', () => {
  const item = makeItem('workflow-review', { flavor: 'unknown' });
  assert.equal(readReviewFlavor(item.message), undefined);
});

// ── isInboxItemHumanVisible ───────────────────────────────────────────────────

test('orchestrator-reviewer workflow-review gate is NOT human-visible', () => {
  const item = makeItem('workflow-review', { flavor: 'orchestrator' });
  assert.equal(isInboxItemHumanVisible(item), false, 'orchestrator gate must be filtered out');
});

test('human-reviewer workflow-review gate IS human-visible', () => {
  const item = makeItem('workflow-review', { flavor: 'human' });
  assert.equal(isInboxItemHumanVisible(item), true, 'human gate must pass through');
});

test('workflow-review without flavor is treated as human (safe default)', () => {
  const item = makeItem('workflow-review', {});
  assert.equal(isInboxItemHumanVisible(item), true);
});

test('verification-review is human-visible', () => {
  const item = makeItem('verification-review');
  assert.equal(isInboxItemHumanVisible(item), true);
});

test('agent-ask-escalated is human-visible', () => {
  const item = makeItem('agent-ask-escalated');
  assert.equal(isInboxItemHumanVisible(item), true);
});

test('agent-question is NOT human-visible', () => {
  const item = makeItem('agent-question');
  assert.equal(isInboxItemHumanVisible(item), false);
});

test('agent-approval is NOT human-visible', () => {
  const item = makeItem('agent-approval');
  assert.equal(isInboxItemHumanVisible(item), false);
});

test('system-notice is NOT human-visible', () => {
  const item = makeItem('system-notice');
  assert.equal(isInboxItemHumanVisible(item), false);
});

test('workflow-run-failed is NOT human-visible', () => {
  const item = makeItem('workflow-run-failed');
  assert.equal(isInboxItemHumanVisible(item), false);
});
