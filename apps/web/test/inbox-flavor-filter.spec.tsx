// pc-pty-chat-267 — MailboxInbox hides orchestrator-flavor workflow-review gates.
// Renders the REAL component; injects fixture items via the hook mock.
// Verifies the flavor-aware filter: orchestrator gates are invisible, human
// gates and other human-actionable kinds are shown.

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

test('orchestrator-flavor workflow-review gate does NOT appear in the inbox', () => {
  mockHook.items = [
    item('workflow-review', { flavor: 'orchestrator', runId: 'r1', nodeId: 'n1' }, 'Push to origin'),
  ];
  render(<MailboxInbox scope={{ projectId: 'p1' }} />);
  expect(screen.queryByText('Push to origin')).not.toBeInTheDocument();
  expect(screen.getByText('No messages.')).toBeInTheDocument();
});

test('human-flavor workflow-review gate DOES appear in the inbox', () => {
  mockHook.items = [
    item('workflow-review', { flavor: 'human', runId: 'r1', nodeId: 'n1' }, 'Human review needed'),
  ];
  render(<MailboxInbox scope={{ projectId: 'p1' }} />);
  expect(screen.getByText('Human review needed')).toBeInTheDocument();
});

test('workflow-review without flavor defaults to human-visible', () => {
  mockHook.items = [
    item('workflow-review', { runId: 'r1', nodeId: 'n1' }, 'Untagged review'),
  ];
  render(<MailboxInbox scope={{ projectId: 'p1' }} />);
  expect(screen.getByText('Untagged review')).toBeInTheDocument();
});

test('inbox shows human-actionable kinds and hides orchestrator-only kinds', () => {
  mockHook.items = [
    item('agent-ask-escalated', { pendingAskId: 'ask-1', options: [] }, 'Escalated ask'),
    item('agent-question', {}, 'Raw question — orchestrator only'),
    item('system-notice', {}, 'System notice — hidden'),
  ];
  render(<MailboxInbox scope={{ projectId: 'p1' }} />);
  expect(screen.getByText('Escalated ask')).toBeInTheDocument();
  expect(screen.queryByText('Raw question — orchestrator only')).not.toBeInTheDocument();
  expect(screen.queryByText('System notice — hidden')).not.toBeInTheDocument();
});
