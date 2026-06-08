// pc-pty-chat-316 — address-driven inbox visibility.
//
// Visibility is NOW server-driven: every inbox route filters to
// addressKinds:['user-inbox'] before sending to the client. The client renders
// exactly what it receives — no second kind-based re-derivation.
//
// What's tested here:
//   1. readReviewFlavor — still a valid utility (reads flavor from the payload).
//   2. The old client visibility gate (isInboxItemHumanVisible) is gone — its
//      removal is asserted so a regression would fail immediately.
// Tests against the REAL exported module so renames / signature breaks fail fast.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readReviewFlavor } from '../src/features/mailbox/MailboxInbox.tsx';
import * as MailboxInboxModule from '../src/features/mailbox/MailboxInbox.tsx';
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

// ── The old client visibility gate is gone (pc-pty-chat-316) ─────────────────

test('isInboxItemHumanVisible is NOT exported — client visibility gate retired', () => {
  assert.equal(
    (MailboxInboxModule as Record<string, unknown>)['isInboxItemHumanVisible'],
    undefined,
    'isInboxItemHumanVisible must be absent: visibility is now server-driven (address-based), not re-derived from kind',
  );
});

test('isInboxVisibleKind is NOT exported — kind-based visibility shim retired', () => {
  assert.equal(
    (MailboxInboxModule as Record<string, unknown>)['isInboxVisibleKind'],
    undefined,
    'isInboxVisibleKind must be absent: visibility is now server-driven (address-based)',
  );
});

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
