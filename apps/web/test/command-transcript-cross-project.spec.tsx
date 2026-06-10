// Regression test for pc-pty-chat-365:
// Clicking a running agent from another project in Command should store the full
// AgentRunRecord so AgentTranscriptModalMount can open the panel in-place,
// NOT route the selection into the home project's page state.
//
// Root cause: CommandActivityPanel called openTranscript(run.runId) without the
// record. AgentTranscriptModalMount only looked up runs in the active project's
// data, found nothing for a cross-project run, left the modal closed, and the
// stale openRunId leaked into the home project's modal mount on next navigation.
//
// Fix: CommandActivityPanel now calls openTranscript(run.runId, run), populating
// preloadedRun in the store. AgentTranscriptModalMount falls back to preloadedRun
// when the run isn't in the active project's live data.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { CommandActivityPanel } from '@/components/CommandActivityPanel';
import { useAgentTranscript } from '@/store/agent-transcript';
import type { Project } from '@/features/projects/client';
import type { AgentRunRecord } from '@/features/agent-runs/client';

// ── Hoisted mocks (vi.hoisted runs before vi.mock factory evaluation) ─────────

const { mockListAgentRuns, mockListWorkflowRuns } = vi.hoisted(() => ({
  mockListAgentRuns: vi.fn(),
  mockListWorkflowRuns: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

// Stub MailboxInbox — it has its own network calls and is not under test here.
vi.mock('@/features/mailbox/MailboxInbox', () => ({
  MailboxInbox: () => null,
}));

vi.mock('@/features/agent-runs/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/agent-runs/client')>();
  return {
    ...actual,
    agentRunsApi: {
      ...actual.agentRunsApi,
      listAgentRuns: mockListAgentRuns,
    },
  };
});

vi.mock('@/features/workflows/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/workflows/client')>();
  return {
    ...actual,
    workflowsApi: {
      ...actual.workflowsApi,
      listV2WorkflowRuns: mockListWorkflowRuns,
    },
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMMAND_PROJECT: Project = {
  id: 'cmd-id',
  slug: '__command__',
  name: 'Command',
  folderPath: '/dev/null',
  gitRemote: null,
  callsignSeq: 0,
  stages: [],
  settings: { cancelledVisibility: 'use-global', remoteControl: 'use-global' },
  notes: null,
  focusedAt: null,
};

const OTHER_PROJECT: Project = {
  id: 'proj-x',
  slug: 'my-project',
  name: 'My Project',
  folderPath: '/tmp/my-project',
  gitRemote: null,
  callsignSeq: 1,
  stages: [],
  settings: { cancelledVisibility: 'use-global', remoteControl: 'use-global' },
  notes: null,
  focusedAt: null,
};

const CROSS_PROJECT_RUN: AgentRunRecord = {
  runId: 'run-abc',
  sessionId: 'sess-1',
  agentName: 'researcher',
  projectId: 'proj-x',
  parentWorkItemId: null,
  wait: false,
  worktreeDir: '/tmp/my-project',
  startedAt: Date.now() - 5000,
  status: 'running',
  result: '',
  failureReason: null,
  failureCause: null,
  endedAt: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CommandActivityPanel — cross-project transcript open (pc-pty-chat-365)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Return the cross-project run for proj-x; empty for any other project.
    mockListAgentRuns.mockImplementation((projectId: string) =>
      projectId === 'proj-x'
        ? Promise.resolve([CROSS_PROJECT_RUN])
        : Promise.resolve([]),
    );
    mockListWorkflowRuns.mockResolvedValue({ runs: [] });
    // Reset the Zustand store so tests are isolated.
    useAgentTranscript.setState({ runId: null, preloadedRun: null });
  });

  test('clicking a cross-project agent row sets preloadedRun in the store', async () => {
    render(
      <CommandActivityPanel
        projects={[COMMAND_PROJECT, OTHER_PROJECT]}
        expanded={true}
        onExpand={vi.fn()}
      />,
    );

    // Wait for the polled agent runs to render the researcher row.
    await waitFor(() => {
      expect(screen.getByText('researcher')).toBeInTheDocument();
    });

    // Click the row — the aria-label is set on the <button> wrapping the row.
    fireEvent.click(screen.getByRole('button', { name: /researcher/i }));

    // The store must carry both the runId AND the full record so
    // AgentTranscriptModalMount can open it in Command without routing to the
    // home project.
    const state = useAgentTranscript.getState();
    expect(state.runId).toBe('run-abc');
    expect(state.preloadedRun).not.toBeNull();
    expect(state.preloadedRun?.runId).toBe('run-abc');
    expect(state.preloadedRun?.projectId).toBe('proj-x');
  });

  test('preloadedRun is cleared when close() is called', () => {
    useAgentTranscript.setState({ runId: 'run-abc', preloadedRun: CROSS_PROJECT_RUN });

    useAgentTranscript.getState().close();

    const state = useAgentTranscript.getState();
    expect(state.runId).toBeNull();
    expect(state.preloadedRun).toBeNull();
  });

  test('open() without a run leaves preloadedRun null (per-project callers unchanged)', () => {
    useAgentTranscript.getState().open('run-xyz');

    const state = useAgentTranscript.getState();
    expect(state.runId).toBe('run-xyz');
    expect(state.preloadedRun).toBeNull();
  });

  test('open() with a run stores it as preloadedRun', () => {
    useAgentTranscript.getState().open(CROSS_PROJECT_RUN.runId, CROSS_PROJECT_RUN);

    const state = useAgentTranscript.getState();
    expect(state.runId).toBe('run-abc');
    expect(state.preloadedRun).toEqual(CROSS_PROJECT_RUN);
  });
});
