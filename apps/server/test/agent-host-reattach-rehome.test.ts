// pc-pty-chat-437 Fix A — re-home guard in handleHostMissingRow.
// Tests 4a (re-home path), 4b (failure/exhaustion), 4c (skip),
// 4d (running row - no re-home), 4e (paused row - FD-14), 4f (reappear).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRunRow, ULID } from '@pc/domain';

import { reconcileAgentRunsAgainstHost } from '../src/services/agent-host-reattach.ts';

function makeRow(id: string, status: AgentRunRow['status'] = 'queued'): AgentRunRow {
  return {
    id: id as ULID, projectId: 'proj-01' as ULID, dispatcherSessionId: 'orch-session',
    ccSessionId: 'cc-' + id, podName: 'researcher', podRevisionAtDispatch: null,
    podRevisionAtResume: null, status, continues: null, parentInvokeDepth: 1,
    parentWorkItemId: null, input: 'do the thing', result: null,
    failureCause: null, failureReason: null, queuedAt: 1_700_000_000_000,
    spawnedAt: null, readyAt: null, pid: null, lastActivityAt: null,
    deliveredAt: null, completedAt: null, rev: 0, contractId: null,
    worktreeDir: null, worktreeBaseBranch: null, worktreeBaseSha: null,
  };
}

const emptyHostClient = {
  listRuns: () => [] as const,
  sendCommand: () => undefined,
};

type TerminalCall = { runId: string; status: string; failureCause?: string | null };

// ---------------------------------------------------------------------------
// 4a: Re-home path
// ---------------------------------------------------------------------------

test('4a-1: queued row, re-home succeeds -> no finalize, both counters reset', async () => {
  const terminalCalls: TerminalCall[] = [];
  const reHomeCalls: string[] = [];
  const missingTicks = new Map<string, number>([['run-q', 7]]);
  const reHomeAttempts = new Map<string, number>();

  const res = await reconcileAgentRunsAgainstHost({
    hostClient: emptyHostClient,
    listNonTerminalRuns: () => [makeRow('run-q')],
    missingFromHostTicks: missingTicks,
    reHomeAttempts,
    hostAuthoritativelyAbsent: true,
    spawnLostAfterTicks: 8,
    reHomeQueuedRun: async (r: AgentRunRow) => { reHomeCalls.push(r.id); return 're-sent'; },
    applyTerminalEffects: ((inp: TerminalCall) => { terminalCalls.push(inp); return { applied: 1 }; }) as never,
  });

  assert.equal(res.hostLost, 0, 'no finalize');
  assert.equal(terminalCalls.length, 0, 'applyTerminalEffects not called');
  assert.equal(reHomeCalls.length, 1, 're-home called once');
  assert.equal(missingTicks.has('run-q'), false, 'missingTicks cleared');
  assert.equal(reHomeAttempts.has('run-q'), false, 'reHomeAttempts cleared');
});

test('4a-2: spawning row, re-home succeeds -> counters reset', async () => {
  const terminalCalls: TerminalCall[] = [];
  const missingTicks = new Map<string, number>([['run-s', 7]]);
  const reHomeAttempts = new Map<string, number>();

  const res = await reconcileAgentRunsAgainstHost({
    hostClient: emptyHostClient,
    listNonTerminalRuns: () => [makeRow('run-s', 'spawning')],
    missingFromHostTicks: missingTicks,
    reHomeAttempts,
    hostAuthoritativelyAbsent: true,
    spawnLostAfterTicks: 8,
    reHomeQueuedRun: async () => 're-sent',
    applyTerminalEffects: ((inp: TerminalCall) => { terminalCalls.push(inp); return { applied: 1 }; }) as never,
  });

  assert.equal(res.hostLost, 0);
  assert.equal(terminalCalls.length, 0);
  assert.equal(missingTicks.has('run-s'), false);
  assert.equal(reHomeAttempts.has('run-s'), false);
});

// ---------------------------------------------------------------------------
// 4b: Re-home failure / exhaustion
// ---------------------------------------------------------------------------

test('4b-1: re-home returns failed -> fall through to finalize on same tick', async () => {
  const terminalCalls: TerminalCall[] = [];
  const reHomeCalls: string[] = [];
  const missingTicks = new Map<string, number>([['run-f', 7]]);
  const reHomeAttempts = new Map<string, number>();

  const res = await reconcileAgentRunsAgainstHost({
    hostClient: emptyHostClient,
    listNonTerminalRuns: () => [makeRow('run-f')],
    missingFromHostTicks: missingTicks,
    reHomeAttempts,
    hostAuthoritativelyAbsent: true,
    spawnLostAfterTicks: 8,
    maxReHomeAttempts: 3,
    reHomeQueuedRun: async (r: AgentRunRow) => { reHomeCalls.push(r.id); return 'failed'; },
    applyTerminalEffects: ((inp: TerminalCall) => { terminalCalls.push(inp); return { applied: 1 }; }) as never,
  });

  assert.equal(res.hostLost, 1, 'finalized');
  assert.equal(terminalCalls.length, 1, 'terminal effects applied');
  assert.equal(terminalCalls[0]!.failureCause, 'host-lost');
  assert.equal(reHomeCalls.length, 1, 're-home called before finalize');
});

test('4b-2: attempts exhausted -> finalize without re-home call', async () => {
  const terminalCalls: TerminalCall[] = [];
  const reHomeCalls: string[] = [];
  const missingTicks = new Map<string, number>([['run-ex', 7]]);
  const reHomeAttempts = new Map<string, number>([['run-ex', 3]]);

  const res = await reconcileAgentRunsAgainstHost({
    hostClient: emptyHostClient,
    listNonTerminalRuns: () => [makeRow('run-ex')],
    missingFromHostTicks: missingTicks,
    reHomeAttempts,
    hostAuthoritativelyAbsent: true,
    spawnLostAfterTicks: 8,
    maxReHomeAttempts: 3,
    reHomeQueuedRun: async (r: AgentRunRow) => { reHomeCalls.push(r.id); return 're-sent'; },
    applyTerminalEffects: ((inp: TerminalCall) => { terminalCalls.push(inp); return { applied: 1 }; }) as never,
  });

  assert.equal(res.hostLost, 1);
  assert.equal(reHomeCalls.length, 0, 're-home skipped (exhausted)');
  assert.equal(terminalCalls.length, 1);
});

test('4c: re-home returns skip -> finalize immediately, re-home called once', async () => {
  const terminalCalls: TerminalCall[] = [];
  const reHomeCalls: string[] = [];
  const missingTicks = new Map<string, number>([['run-sk', 7]]);
  const reHomeAttempts = new Map<string, number>();

  const res = await reconcileAgentRunsAgainstHost({
    hostClient: emptyHostClient,
    listNonTerminalRuns: () => [makeRow('run-sk')],
    missingFromHostTicks: missingTicks,
    reHomeAttempts,
    hostAuthoritativelyAbsent: true,
    spawnLostAfterTicks: 8,
    reHomeQueuedRun: async (r: AgentRunRow) => { reHomeCalls.push(r.id); return 'skip'; },
    applyTerminalEffects: ((inp: TerminalCall) => { terminalCalls.push(inp); return { applied: 1 }; }) as never,
  });

  assert.equal(res.hostLost, 1);
  assert.equal(terminalCalls[0]!.failureCause, 'host-lost');
  assert.equal(reHomeCalls.length, 1, 're-home called once then fell through');
});

// ---------------------------------------------------------------------------
// 4d: Running row — no re-home, finalize at lostAfterTicks
// ---------------------------------------------------------------------------

test('4d: running row -> no re-home called, finalize at lostAfterTicks', async () => {
  const terminalCalls: TerminalCall[] = [];
  const reHomeCalls: string[] = [];
  const missingTicks = new Map<string, number>([['run-r', 1]]);
  const reHomeAttempts = new Map<string, number>();

  const res = await reconcileAgentRunsAgainstHost({
    hostClient: emptyHostClient,
    listNonTerminalRuns: () => [makeRow('run-r', 'running')],
    missingFromHostTicks: missingTicks,
    reHomeAttempts,
    hostAuthoritativelyAbsent: true,
    hostLostAfterTicks: 2,
    reHomeQueuedRun: async (r: AgentRunRow) => { reHomeCalls.push(r.id); return 're-sent'; },
    applyTerminalEffects: ((inp: TerminalCall) => { terminalCalls.push(inp); return { applied: 1 }; }) as never,
  });

  assert.equal(res.hostLost, 1);
  assert.equal(reHomeCalls.length, 0, 're-home not called for running rows');
  assert.equal(terminalCalls.length, 1);
  assert.equal(terminalCalls[0]!.failureCause, 'host-lost');
});

// ---------------------------------------------------------------------------
// 4e: Paused row — no re-home, no finalize, counters cleared (FD-14)
// ---------------------------------------------------------------------------

test('4e: paused row -> no re-home, no finalize, counters cleared (FD-14)', async () => {
  const terminalCalls: TerminalCall[] = [];
  const reHomeCalls: string[] = [];
  const missingTicks = new Map<string, number>([['run-p', 50]]);
  const reHomeAttempts = new Map<string, number>([['run-p', 2]]);

  const res = await reconcileAgentRunsAgainstHost({
    hostClient: emptyHostClient,
    listNonTerminalRuns: () => [makeRow('run-p', 'paused')],
    missingFromHostTicks: missingTicks,
    reHomeAttempts,
    hostAuthoritativelyAbsent: true,
    hostLostAfterTicks: 2,
    reHomeQueuedRun: async (r: AgentRunRow) => { reHomeCalls.push(r.id); return 're-sent'; },
    applyTerminalEffects: ((inp: TerminalCall) => { terminalCalls.push(inp); return { applied: 1 }; }) as never,
  });

  assert.equal(res.hostLost, 0, 'paused row never finalized');
  assert.equal(reHomeCalls.length, 0);
  assert.equal(terminalCalls.length, 0);
  assert.equal(missingTicks.has('run-p'), false, 'missingTicks cleared for paused');
  assert.equal(reHomeAttempts.has('run-p'), false, 'reHomeAttempts cleared for paused');
});

// ---------------------------------------------------------------------------
// 4f: Run reappears on host — both counters cleared
// ---------------------------------------------------------------------------

test('4f: run reappears on host (standing reHomeAttempts) -> both counters cleared', async () => {
  const hostSnapshot = {
    runId: 'run-reappear' as ULID, projectId: 'proj-01' as ULID,
    dispatcherSessionId: 'orch-session', ccSessionId: 'cc-run-reappear',
    podName: 'researcher', worktreeDir: '', state: 'running' as const,
    jsonlPath: null, transcriptPath: null, queuedAt: 1_700_000_000_000,
    spawnedAt: null, readyAt: null, updatedAt: 1_700_000_000_000, terminalAt: null,
  };
  const hostClient = { listRuns: () => [hostSnapshot], sendCommand: () => undefined };
  const missingTicks = new Map<string, number>([['run-reappear', 5]]);
  const reHomeAttempts = new Map<string, number>([['run-reappear', 2]]);
  const terminalCalls: TerminalCall[] = [];

  const res = await reconcileAgentRunsAgainstHost({
    hostClient,
    listNonTerminalRuns: () => [makeRow('run-reappear', 'running')],
    missingFromHostTicks: missingTicks,
    reHomeAttempts,
    hostAuthoritativelyAbsent: true,
    updateStatus: () => {},
    announce: () => {},
    applyTerminalEffects: ((inp: TerminalCall) => { terminalCalls.push(inp); return { applied: 1 }; }) as never,
  });

  assert.equal(res.hostLost, 0);
  assert.equal(terminalCalls.length, 0);
  assert.equal(missingTicks.has('run-reappear'), false, 'missingTicks cleared on reappear');
  assert.equal(reHomeAttempts.has('run-reappear'), false, 'reHomeAttempts cleared on reappear');
});
