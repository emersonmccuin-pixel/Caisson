// pc-pty-chat-415 (R5) — guard: ACCEPTANCE TRIGGERS LANDING, structurally.
//
// The terminal-effects tail must call the landing service exactly when
// auto-verification PASSES a contract — and never on a failed/pending verdict.
// (What landing does is covered by landing-service.test.ts; this pins the
// wiring so "accepted but never landed" can't regrow.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-accept-lands-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createOrchestratorSession, createProject, insertAgentRunRow, newId, runMigrations } =
  await import('@pc/db');
const { ContractService } = await import('@pc/app-services');

import type { Stage, ULID } from '@pc/domain';
import { applyAgentRunTerminalEffects } from '../src/services/agent-run-terminal-effects.ts';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function runTerminal(slug: string, verdict: 'passed' | 'failed') {
  const p = createProject({ slug, name: slug, stages, folderPath: join(tmpDir, slug) });
  const session = createOrchestratorSession({ projectId: p.id, providerSessionId: `cc-${slug}` });
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo' },
    verificationTier: 'auto',
  });
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: p.id as ULID,
    podName: 'code-writer',
    dispatcherSessionId: session.id,
    ccSessionId: `cc-${slug}`,
    status: 'running',
    input: 'go',
    contractId: contract.id as ULID,
    queuedAt: Date.now(),
  });

  const landed: string[] = [];
  applyAgentRunTerminalEffects(
    {
      runId,
      ccSessionId: `cc-${slug}`,
      podName: 'code-writer',
      projectId: p.id as ULID,
      dispatcherSessionId: session.id,
      parentWorkItemId: null,
      worktreeDir: join(tmpDir, 'worktrees', slug, 'agent-x'),
      slug,
      status: 'completed',
      result: 'done',
      completedAt: Date.now(),
      startedAt: Date.now(),
      contractId: contract.id as ULID,
    },
    {
      markTerminal: () => {},
      verifyOnTerminal: async (input) => ({
        contractId: input.contractId as ULID,
        workItemId: null,
        verificationStatus: verdict,
        verificationTier: 'auto',
        notes: null,
        predicatesEvaluated: 1,
      }),
      landAcceptedContract: async (contractId) => {
        landed.push(contractId);
        return { applicable: true, outcome: 'landed', branch: 'agent-x', into: 'dev' };
      },
      mailboxEnqueue: () => {},
    },
  );
  await new Promise((r) => setTimeout(r, 100));
  return { contractId: contract.id, landed };
}

test('passed auto-verification triggers the landing service with the contract id', async () => {
  const { contractId, landed } = await runTerminal('al-pass', 'passed');
  assert.deepEqual(landed, [contractId], 'acceptance must land — exactly once');
});

test('failed verification never triggers landing', async () => {
  const { landed } = await runTerminal('al-fail', 'failed');
  assert.deepEqual(landed, [], 'rejected work must not land');
});
