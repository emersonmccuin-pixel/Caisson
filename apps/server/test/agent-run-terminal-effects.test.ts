// pc-pty-chat-437 Fix C/D — failureCause threading from applyAgentRunTerminalEffects
// into the verifier call. Guards that the failureCause arriving in the terminal
// effects input is passed through to runVerificationOnTerminal so Fix D's
// INFRA_FAILURE_CAUSES split can fire correctly.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';
import type { RunVerificationInput, VerificationOutcome } from '../src/services/agent-verification.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-te-failurecause-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  insertAgentRunRow,
  newId,
  runMigrations,
} = await import('@pc/db');
const { applyAgentRunTerminalEffects } = await import(
  '../src/services/agent-run-terminal-effects.ts'
);

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

function seedRun(slug: string): { runId: ULID; projectId: ULID } {
  const project = createProject({
    slug,
    name: slug,
    stages,
    folderPath: join(tmpDir, slug),
  });
  const session = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: 'cc-verify',
  });
  const runId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'researcher',
    dispatcherSessionId: session.id,
    ccSessionId: 'cc-verify',
    status: 'running',
    input: 'go',
    queuedAt: Date.now(),
    contractId: newId(),
  });
  return { runId, projectId: project.id };
}

// ---------------------------------------------------------------------------
// 4d-1: host-lost cause is threaded into the verifier call
// ---------------------------------------------------------------------------

test('4d-1: failureCause host-lost threaded from applyAgentRunTerminalEffects to verifier', async () => {
  const { runId, projectId } = seedRun('te-hostlost');
  const verifierCalls: RunVerificationInput[] = [];

  const fakeVerifier = async (input: RunVerificationInput): Promise<VerificationOutcome | null> => {
    verifierCalls.push(input);
    return null;
  };

  applyAgentRunTerminalEffects(
    {
      runId,
      ccSessionId: 'cc-verify',
      podName: 'researcher',
      projectId,
      dispatcherSessionId: 'disp',
      parentWorkItemId: null,
      worktreeDir: join(tmpDir, 'wt'),
      status: 'failed',
      failureCause: 'host-lost',
      failureReason: 'agent host no longer owns this non-terminal run',
    },
    {
      markTerminal: () => {},
      verifyOnTerminal: fakeVerifier,
    },
  );

  // finishTerminalEffects is fire-and-forget; yield to let it settle.
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(verifierCalls.length, 1, 'verifier called once');
  assert.equal(verifierCalls[0]!.failureCause, 'host-lost', 'failureCause threaded to verifier');
  assert.equal(verifierCalls[0]!.terminalStatus, 'failed');
});

// ---------------------------------------------------------------------------
// 4d-2: server-restart cause is also threaded (another INFRA_FAILURE_CAUSES member)
// ---------------------------------------------------------------------------

test('4d-2: failureCause server-restart threaded to verifier', async () => {
  const { runId, projectId } = seedRun('te-serverrestart');
  const verifierCalls: RunVerificationInput[] = [];

  const fakeVerifier = async (input: RunVerificationInput): Promise<VerificationOutcome | null> => {
    verifierCalls.push(input);
    return null;
  };

  applyAgentRunTerminalEffects(
    {
      runId,
      ccSessionId: 'cc-verify',
      podName: 'researcher',
      projectId,
      dispatcherSessionId: 'disp',
      parentWorkItemId: null,
      worktreeDir: join(tmpDir, 'wt'),
      status: 'failed',
      failureCause: 'server-restart',
      failureReason: 'server restarted',
    },
    {
      markTerminal: () => {},
      verifyOnTerminal: fakeVerifier,
    },
  );

  await new Promise((r) => setTimeout(r, 150));

  assert.equal(verifierCalls.length, 1);
  assert.equal(verifierCalls[0]!.failureCause, 'server-restart');
});

// ---------------------------------------------------------------------------
// 4d-3: agent cause (idle-timeout) is also threaded (preserves existing path)
// ---------------------------------------------------------------------------

test('4d-3: failureCause idle-timeout threaded to verifier (agent cause)', async () => {
  const { runId, projectId } = seedRun('te-idletimeout');
  const verifierCalls: RunVerificationInput[] = [];

  const fakeVerifier = async (input: RunVerificationInput): Promise<VerificationOutcome | null> => {
    verifierCalls.push(input);
    return null;
  };

  applyAgentRunTerminalEffects(
    {
      runId,
      ccSessionId: 'cc-verify',
      podName: 'researcher',
      projectId,
      dispatcherSessionId: 'disp',
      parentWorkItemId: null,
      worktreeDir: join(tmpDir, 'wt'),
      status: 'failed',
      failureCause: 'idle-timeout',
      failureReason: 'agent timed out',
    },
    {
      markTerminal: () => {},
      verifyOnTerminal: fakeVerifier,
    },
  );

  await new Promise((r) => setTimeout(r, 150));

  assert.equal(verifierCalls.length, 1);
  assert.equal(verifierCalls[0]!.failureCause, 'idle-timeout');
});
