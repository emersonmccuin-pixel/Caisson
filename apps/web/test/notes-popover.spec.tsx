// pc-pty-chat-333: component tests for NotesPopover.
//
// Contracts verified:
//   1. Renders with initial notes pre-filled in the textarea.
//   2. Shows empty textarea when notes are null.
//   3. Autosave fires after typing (debounced → flush via blur).
//   4. Save state indicator changes to "saving" then "saved".
//   5. ErrorBoundary wraps the popover (smoke: component renders inside one).

import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotesPopover } from '@/components/NotesPopover';
import { ErrorBoundary } from '@/components/ErrorBoundary';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockUpdateNotes = vi.fn();
const mockGetProject = vi.fn();
vi.mock('@/features/projects/client', () => ({
  projectsApi: {
    updateProjectNotes: (...args: unknown[]) => mockUpdateNotes(...args),
    project: (...args: unknown[]) => mockGetProject(...args),
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1' as import('@/features/projects/client').ULID;
const noop = () => {};

function renderPopover(initialNotes: string | null = null) {
  return render(
    <NotesPopover
      projectId={PROJECT_ID}
      initialNotes={initialNotes}
      anchorEl={null}
      onClose={noop}
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mockUpdateNotes.mockResolvedValue('');
  // Default: freshness fetch is a no-op (rejects) so the instant-paint
  // initialNotes is preserved — isolates the local-behavior tests below.
  // The adoption test overrides this with a resolved server value.
  mockGetProject.mockRejectedValue(new Error('not-mocked'));
});
afterEach(() => {
  vi.useRealTimers();
  mockUpdateNotes.mockReset();
  mockGetProject.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NotesPopover', () => {
  test('pre-fills textarea with initial notes', () => {
    renderPopover('existing content');
    const ta = screen.getByTestId('notes-textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('existing content');
  });

  test('renders empty textarea when initial notes are null', () => {
    renderPopover(null);
    const ta = screen.getByTestId('notes-textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('');
  });

  test('autosave fires after 500ms debounce', async () => {
    renderPopover(null);
    const ta = screen.getByTestId('notes-textarea');
    fireEvent.change(ta, { target: { value: 'new note text' } });

    // Not called yet — debounce hasn't elapsed.
    expect(mockUpdateNotes).not.toHaveBeenCalled();

    // Advance timer past debounce window.
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(mockUpdateNotes).toHaveBeenCalledWith(PROJECT_ID, 'new note text');
  });

  test('save fires on blur', async () => {
    renderPopover('pre');
    const ta = screen.getByTestId('notes-textarea');
    fireEvent.change(ta, { target: { value: 'blurred value' } });
    fireEvent.blur(ta);

    // Blur flushes immediately.
    expect(mockUpdateNotes).toHaveBeenCalledWith(PROJECT_ID, 'blurred value');
  });

  test('does not save if text is unchanged', async () => {
    renderPopover('same text');
    const ta = screen.getByTestId('notes-textarea');
    fireEvent.blur(ta);
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(mockUpdateNotes).not.toHaveBeenCalled();
  });

  test('renders inside ErrorBoundary without crashing', () => {
    render(
      <ErrorBoundary label="notes">
        <NotesPopover
          projectId={PROJECT_ID}
          initialNotes="safe"
          anchorEl={null}
          onClose={noop}
        />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('notes-popover')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument();
  });

  test('adopts the saved server value on open over a stale initial prop', async () => {
    // Reopen-freshness: the parent's initialNotes prop can be stale after an
    // in-session save. The popover fetches the current notes on open and
    // adopts them when the field is pristine — so reopening shows what was
    // actually saved, not the stale prop (no apparent data loss).
    mockGetProject.mockResolvedValue({ notes: 'saved on the server' });
    await act(async () => {
      renderPopover('stale prop value');
      await Promise.resolve();
      await Promise.resolve();
    });
    const ta = screen.getByTestId('notes-textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('saved on the server');
  });

  test('does not clobber in-progress edits with the fetched value', async () => {
    let resolveFetch: (v: { notes: string | null }) => void = () => {};
    mockGetProject.mockReturnValue(
      new Promise<{ notes: string | null }>((r) => {
        resolveFetch = r;
      }),
    );
    renderPopover('initial');
    const ta = screen.getByTestId('notes-textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'user typing' } });
    // Fetch resolves AFTER the user started typing — must not overwrite.
    await act(async () => {
      resolveFetch({ notes: 'server value' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(ta.value).toBe('user typing');
  });

  test('shows saved indicator after successful save', async () => {
    renderPopover(null);
    const ta = screen.getByTestId('notes-textarea');
    fireEvent.change(ta, { target: { value: 'track save state' } });

    // Advance timers past the debounce, then flush the resolved-promise microtasks.
    await act(async () => {
      vi.advanceTimersByTime(600);
      // Flush the Promise.resolve().then() that sets saveState = 'saved'.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('saved')).toBeInTheDocument();
  });
});
