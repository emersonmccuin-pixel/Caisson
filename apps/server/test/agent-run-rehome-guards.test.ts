// 2026-07-03 — dispatch invariants apply to RE-dispatch too.
//
// reHomeRunOnCurrentHost reconstructs a start-run from a stored queued/spawning
// row. A row without a contract is a crash orphan from the pre-insert→contract
// window; a row whose worktree dir no longer exists was never fully
// provisioned (or was reclaimed). Both must return 'skip' (→ the reconciler
// finalizes the row as a typed host-lost failure) BEFORE anything reaches the
// host. These guards run before any DB/pod access, so no migrations needed.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentRunRow, ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-rehome-guards-'));
process.env['PC_DATA_DIR'] = tmpDir;

const { reHomeRunOnCurrentHost } = await import('../src/services/agent-run-rehome.ts');
import type { AgentHostReattachClient } from '../src/services/agent-host-reattach.ts';

after(() => rmSync(tmpDir, { recursive: true, force: true }));

function makeRow(overrides: Partial<AgentRunRow>): AgentRunRow {
  return {
    id: 'run-guard' as ULID, projectId: 'proj-01' as ULID, dispatcherSessionId: 'orch',
    ccSessionId: 'cc-guard', podName: 'researcher', podRevisionAtDispatch: null,
    podRevisionAtResume: null, status: 'queued', continues: null, parentInvokeDepth: 1,
    parentWorkItemId: null, input: 'do the thing', result: null,
    failureCause: null, failureReason: null, queuedAt: 1_700_000_000_000,
    spawnedAt: null, readyAt: null, pid: null, lastActivityAt: null,
    deliveredAt: null, completedAt: null, rev: 0, contractId: null,
    worktreeDir: null, worktreeBaseBranch: null, worktreeBaseSha: null,
    ...overrides,
  };
}

/** Trips loudly if the guards ever let a bad row through to the host. */
const explodingHost = {
  sendCommand: () => {
    throw new Error('guard failure: start-run must never reach the host');
  },
} as unknown as AgentHostReattachClient;

test('re-home: contract-less row → skip (never re-spawn contract-less)', async () => {
  const dir = join(tmpDir, 'wt-ok');
  mkdirSync(dir, { recursive: true });
  const result = await reHomeRunOnCurrentHost(
    makeRow({ contractId: null, worktreeDir: dir }),
    explodingHost,
  );
  assert.equal(result, 'skip');
});

test('re-home: worktree dir gone from disk → skip (never spawn into a phantom cwd)', async () => {
  const result = await reHomeRunOnCurrentHost(
    makeRow({ contractId: 'contract-01' as ULID, worktreeDir: join(tmpDir, 'never-created') }),
    explodingHost,
  );
  assert.equal(result, 'skip');
});

test('re-home: empty/null worktreeDir → skip', async () => {
  const nullDir = await reHomeRunOnCurrentHost(
    makeRow({ contractId: 'contract-01' as ULID, worktreeDir: null }),
    explodingHost,
  );
  assert.equal(nullDir, 'skip');

  const emptyDir = await reHomeRunOnCurrentHost(
    makeRow({ contractId: 'contract-01' as ULID, worktreeDir: '   ' }),
    explodingHost,
  );
  assert.equal(emptyDir, 'skip');
});
