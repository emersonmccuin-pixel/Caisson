// pc-pty-chat-316 — address-driven inbox: MailboxInbox renders what the server returns.
//
// The server pre-filters every inbox route to user-inbox recipients; the client
// renders exactly what the hook delivers — no second kind-based re-classification.
//
// These tests inject fixture items via the hook mock and assert render outcomes:
//   - known human-actionable kinds show
//   - an UNKNOWN / future kind addressed to user-inbox STILL shows (no silent drop)
//   - orchestrator-flavor workflow-review never reaches the hook in production
//     (server-filtered), and if it somehow did, it would show rather than vanish

import { render, screen } from '@testing-library/react';
import { test, expect, vi, beforeEach } from 'vitest';
import { MailboxInbox } from '@/features/mailbox/MailboxInbox';
import type { MailboxInboxItem } from '@/features/mailbox/types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockHook: { items: MailboxInboxItem[]; loading: boolean; refetch: () => void } = {
  items: [],
  loading: false,
  refetch: vi.fn(),
};
vi.mock('@/hooks/use-mailbox-inbox', () => ({
  useMailboxInbox: () => mockHook,
}));

vi.mock('@/features/mailbox/ReviewModal', () => ({
  ReviewModal: () => <div data-testid="review-modal" />,
}));

vi.mock('@/features/mailbox/client', () => ({
  mailboxApi: {
    markRead: vi.fn(),
    dismiss: vi.fn(),
    answerPendingAsk: vi.fn(),
    cancelPendingAsk: vi.fn(),
  },
}));

// ── Fixture helpers ───────────────────────────────────────────────────────────

function item(
  kind: MailboxInboxItem['message']['kind'],
  payload: Record<string, unknown>,
  subject: string,
): MailboxInboxItem {
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
      subject,
      body: `body of ${subject}`,
      payload,
      source: { kind: 'system', id: null },
      idempotencyKey: 'k1',
      createdAt: Date.now() - 5000,
      updatedAt: Date.now() - 5000,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// Key acceptance criterion: unknown/future kinds addressed to user-inbox must
// show rather than silently drop. The server has already done the visibility
// gate (address filter); the client must not add a second gate.
test('unknown kind addressed to user-inbox STILL shows (no silent drop)', () => {
  mockHook.items = [
    // Use a type assertion to simulate a future kind not yet in the union.
    item('system-notice' as MailboxInboxItem['message']['kind'], {}, 'Future kind message'),
  ];
  // Directly override kind to a value not in KIND_ORDER to simulate a truly unknown kind.
  const unknownItem = { ...mockHook.items[0] };
  unknownItem.message = { ...mockHook.items[0].message, kind: 'some-future-kind' as MailboxInboxItem['message']['kind'] };
  mockHook.items = [unknownItem];
  render(<MailboxInbox scope={{ projectId: 'p1' }} />);
  // Must show — not silently dropped.
  expect(screen.getByText('Future kind message')).toBeInTheDocument();
});

test('human-flavor workflow-review gate DOES appear in the inbox', () => {
  mockHook.items = [
    item('workflow-review', { flavor: 'human', runId: 'r1', nodeId: 'n1' }, 'Human review needed'),
  ];
  render(<MailboxInbox scope={{ projectId: 'p1' }} />);
  expect(screen.getByText('Human review needed')).toBeInTheDocument();
});

test('workflow-review without flavor shows (server decided it belongs here)', () => {
  mockHook.items = [
    item('workflow-review', { runId: 'r1', nodeId: 'n1' }, 'Untagged review'),
  ];
  render(<MailboxInbox scope={{ projectId: 'p1' }} />);
  expect(screen.getByText('Untagged review')).toBeInTheDocument();
});

test('verification-review shows in the inbox', () => {
  mockHook.items = [
    item('verification-review', { contractId: 'c1' }, 'Agent deliverable ready'),
  ];
  render(<MailboxInbox scope={{ projectId: 'p1' }} />);
  expect(screen.getByText('Agent deliverable ready')).toBeInTheDocument();
});

test('agent-ask-escalated shows in the inbox', () => {
  mockHook.items = [
    item('agent-ask-escalated', { pendingAskId: 'ask-1', options: [] }, 'Escalated ask'),
  ];
  render(<MailboxInbox scope={{ projectId: 'p1' }} />);
  expect(screen.getByText('Escalated ask')).toBeInTheDocument();
});

test('all items returned by the hook are rendered (no client kind filter)', () => {
  mockHook.items = [
    item('agent-ask-escalated', { pendingAskId: 'ask-1', options: [] }, 'Escalated ask'),
    item('verification-review', { contractId: 'c1' }, 'Deliverable ready'),
    item('workflow-review', { flavor: 'human', runId: 'r1', nodeId: 'n1' }, 'Workflow gate'),
  ];
  render(<MailboxInbox scope={{ projectId: 'p1' }} />);
  expect(screen.getByText('Escalated ask')).toBeInTheDocument();
  expect(screen.getByText('Deliverable ready')).toBeInTheDocument();
  expect(screen.getByText('Workflow gate')).toBeInTheDocument();
});

test('empty hook result shows "No messages."', () => {
  mockHook.items = [];
  render(<MailboxInbox scope={{ projectId: 'p1' }} />);
  expect(screen.getByText('No messages.')).toBeInTheDocument();
});
