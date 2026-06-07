// Real-component tests for the MailboxInbox / MailboxInboxRow.
//
// Contracts tested:
//   1. No project badge rendered when projectNames is omitted (in-project scope fix).
//   2. Clicking a workflow-review row opens ReviewModal, NOT an inline expand.
//   3. Clicking a non-review (agent-ask-escalated) row toggles inline expand, NOT modal.
//   4. ReviewModal opens for an already-decided review card (not just actionable ones).

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MailboxInbox } from '@/features/mailbox/MailboxInbox';
import type { MailboxInboxItem } from '@/features/mailbox/types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// useMailboxInbox — injected fixture items; no real network.
const mockItems: { items: MailboxInboxItem[]; loading: boolean; refetch: () => void } = {
  items: [],
  loading: false,
  refetch: vi.fn(),
};
vi.mock('@/hooks/use-mailbox-inbox', () => ({
  useMailboxInbox: () => mockItems,
}));

// ReviewModal — replace with a test-id sentinel so we can detect if it opened.
vi.mock('@/features/mailbox/ReviewModal', () => ({
  ReviewModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="review-modal">
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

// mailboxApi — stub action endpoints.
vi.mock('@/features/mailbox/client', () => ({
  mailboxApi: {
    markRead: vi.fn().mockResolvedValue({}),
    dismiss: vi.fn().mockResolvedValue({}),
    answerPendingAsk: vi.fn().mockResolvedValue({ ok: true }),
    cancelPendingAsk: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function msg(overrides: Partial<MailboxInboxItem['message']>): MailboxInboxItem['message'] {
  return {
    id: 'msg-1',
    projectId: 'p1',
    kind: 'workflow-review',
    subject: 'Build review for pc-test',
    body: 'This is the body text',
    payload: {
      runId: 'run-1',
      nodeId: 'review-node',
      workflowName: 'Build Workflow',
      workItemId: 'wi-1',
      prompt: 'Review the build',
      summary: 'Build summary',
      escalated: false,
      iteration: 1,
    },
    source: { kind: 'workflow', id: 'wf-1' } as MailboxInboxItem['message']['source'],
    idempotencyKey: 'k1',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    ...overrides,
  };
}

function rcpt(overrides: Partial<MailboxInboxItem['recipient']> = {}): MailboxInboxItem['recipient'] {
  return {
    id: 'rcpt-1',
    messageId: 'msg-1',
    address: { kind: 'user', userId: 'u1' } as MailboxInboxItem['recipient']['address'],
    readAt: null,
    actionedAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

function reviewItem(msgOverrides?: Partial<MailboxInboxItem['message']>, rcptOverrides?: Partial<MailboxInboxItem['recipient']>): MailboxInboxItem {
  return { message: msg(msgOverrides), recipient: rcpt(rcptOverrides) };
}

function nonReviewItem(): MailboxInboxItem {
  return {
    message: msg({
      kind: 'agent-ask-escalated',
      subject: 'Agent question',
      body: 'What should I do?',
      payload: { pendingAskId: 'ask-1', options: [] },
    }),
    recipient: rcpt({ actionedAt: null }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MailboxInbox — in-project scope (no projectNames)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders without a project badge when projectNames is not passed', () => {
    mockItems.items = [reviewItem()];
    render(<MailboxInbox scope={{ projectId: 'p1' }} />);
    // The project name "CAISSON" or any project badge text should not appear.
    // (No projectNames prop → projectName resolves null → badge not rendered.)
    expect(screen.queryByText(/caisson/i)).not.toBeInTheDocument();
  });

  test('does NOT render project badge even if projectId is set on the message', () => {
    mockItems.items = [reviewItem({ projectId: 'p1' })];
    // Intentionally omit projectNames.
    render(<MailboxInbox scope={{ projectId: 'p1' }} />);
    // Badge only renders when projectNames maps the id → a display name;
    // without that map there is no badge text to find.
    expect(document.querySelectorAll('[class*="bg-accent"]')).toHaveLength(0);
  });
});

describe('MailboxInboxRow — review kind click behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('clicking a workflow-review row opens ReviewModal (not inline expand)', () => {
    mockItems.items = [reviewItem()];
    render(<MailboxInbox scope={{ projectId: 'p1' }} />);

    // Modal should not be visible before click.
    expect(screen.queryByTestId('review-modal')).not.toBeInTheDocument();

    // Click the row button (contains the subject text).
    fireEvent.click(screen.getByText('Build review for pc-test'));

    // Modal is now rendered.
    expect(screen.getByTestId('review-modal')).toBeInTheDocument();

    // Body text should NOT appear inline (modal handles it, not expand).
    expect(screen.queryByText('This is the body text')).not.toBeInTheDocument();
  });

  test('clicking a review row opens modal even when card is already decided (non-actionable)', () => {
    // actionedAt set → isActionableMailboxKind returns false → actionable = false.
    mockItems.items = [reviewItem(undefined, { actionedAt: Date.now() - 1000 })];
    render(<MailboxInbox scope={{ projectId: 'p1' }} />);

    expect(screen.queryByTestId('review-modal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Build review for pc-test'));
    expect(screen.getByTestId('review-modal')).toBeInTheDocument();
  });

  test('modal closes when Close is clicked', () => {
    mockItems.items = [reviewItem()];
    render(<MailboxInbox scope={{ projectId: 'p1' }} />);

    fireEvent.click(screen.getByText('Build review for pc-test'));
    expect(screen.getByTestId('review-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByTestId('review-modal')).not.toBeInTheDocument();
  });
});

describe('MailboxInboxRow — non-review kind click behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('clicking a non-review row shows inline body, NOT the review modal', () => {
    mockItems.items = [nonReviewItem()];
    render(<MailboxInbox scope={{ projectId: 'p1' }} />);

    // Modal absent before and after.
    expect(screen.queryByTestId('review-modal')).not.toBeInTheDocument();

    // Click to expand.
    fireEvent.click(screen.getByText('Agent question'));

    // Modal still absent.
    expect(screen.queryByTestId('review-modal')).not.toBeInTheDocument();

    // Inline body now visible.
    expect(screen.getByText('What should I do?')).toBeInTheDocument();
  });

  test('second click on non-review row collapses the inline body', () => {
    mockItems.items = [nonReviewItem()];
    render(<MailboxInbox scope={{ projectId: 'p1' }} />);

    fireEvent.click(screen.getByText('Agent question'));
    expect(screen.getByText('What should I do?')).toBeInTheDocument();

    // Collapse.
    fireEvent.click(screen.getByText('Agent question'));
    expect(screen.queryByText('What should I do?')).not.toBeInTheDocument();
  });
});
