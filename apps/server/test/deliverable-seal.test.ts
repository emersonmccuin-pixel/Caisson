// pc-pty-chat-415 (R4) — seal before verify.
//
// A repo deliverable is only accepted from a COMMITTED worktree:
//   - dirty worktree   → 409 `uncommitted-work` (typed, retryable; nothing
//     persisted — no deliverable on the contract, no delivered receipt)
//   - probe failure    → 409 (cannot-confirm is NOT clean)
//   - clean worktree   → 200; the engine stamps the sealed branch + HEAD sha
//     onto the deliverable from git directly (receipts, not agent claims)
//   - legacy in-place run (cwd == project folder) → exempt (the live copy's
//     dirtiness belongs to the human, not the agent)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-deliverable-seal-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  getAgentRunRow,
  getContract,
  insertAgentRunRow,
  newId,
} = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');

import type { Stage, ULID } from '@pc/domain';
import { registerAgentRunRoutes } from '../src/features/agent-runs/routes.ts';
import type { GitReceipts } from '../src/services/git-receipts.ts';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkApp(gitReceipts: GitReceipts): Hono {
  const app = new Hono();
  registerAgentRunRoutes(app, {
    broadcastTo: () => {},
    getActiveRunRegistry: () => ({ get: () => null }),
    gitReceipts,
  });
  return app;
}

function seedRepoRun(slug: string, worktreeDir: string | null) {
  const p = createProject({ slug, name: slug, stages, folderPath: join(tmpDir, slug) });
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    podName: 'code-writer',
    expectedOutput: { kind: 'repo' },
  });
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: p.id as ULID,
    podName: 'code-writer',
    dispatcherSessionId: 's',
    ccSessionId: 'cc',
    status: 'running',
    input: 'go',
    contractId: contract.id as ULID,
    worktreeDir: worktreeDir ?? undefined,
    queuedAt: Date.now(),
  });
  return { p, contract, runId };
}

const WT = join(tmpDir, 'worktrees', 'agent-seal-test');

function receipts(overrides: Partial<GitReceipts>): GitReceipts {
  return {
    workingTreeStatus: async () => 'clean',
    headSha: async () => 'abc123sealed',
    currentBranch: async () => 'agent-seal-test',
    ...overrides,
  };
}

test('seal: dirty worktree refuses 409 uncommitted-work and persists NOTHING', async () => {
  const { p, contract, runId } = seedRepoRun('seal-dirty', WT);
  const app = mkApp(receipts({ workingTreeStatus: async () => 'dirty' }));

  const res = await app.request(`/api/projects/${p.id}/agent-runs/${runId}/deliverable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliverable: { kind: 'repo', branch: 'claimed' } }),
  });

  assert.equal(res.status, 409);
  const body = (await res.json()) as { ok: boolean; cause: string; error: string };
  assert.equal(body.cause, 'uncommitted-work');
  assert.match(body.error, /commit/i, 'refusal must tell the agent to commit and resubmit');

  const c = getContract(contract.id as ULID);
  assert.equal(c!.deliverable, null, 'no deliverable persisted on a refused submit');
  const row = getAgentRunRow(runId);
  assert.ok(!row!.deliveredAt, 'no delivered receipt on a refused submit');
});

test('seal: probe failure (unknown) also refuses — cannot-confirm is not clean', async () => {
  const { p, runId } = seedRepoRun('seal-unknown', WT);
  const app = mkApp(receipts({ workingTreeStatus: async () => 'unknown' }));

  const res = await app.request(`/api/projects/${p.id}/agent-runs/${runId}/deliverable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliverable: { kind: 'repo' } }),
  });

  assert.equal(res.status, 409);
  const body = (await res.json()) as { cause: string };
  assert.equal(body.cause, 'uncommitted-work');
});

test('seal: clean worktree accepts and stamps engine-read branch + sha over agent claims', async () => {
  const { p, contract, runId } = seedRepoRun('seal-clean', WT);
  const app = mkApp(
    receipts({
      headSha: async () => 'deadbeef42',
      currentBranch: async () => 'agent-12345678',
    }),
  );

  const res = await app.request(`/api/projects/${p.id}/agent-runs/${runId}/deliverable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deliverable: { kind: 'repo', branch: 'agent-claimed-branch', commit: 'agent-claimed-sha' },
    }),
  });

  assert.equal(res.status, 200);
  const c = getContract(contract.id as ULID);
  const d = c!.deliverable as { kind: string; branch?: string; commit?: string };
  assert.equal(d.kind, 'repo');
  assert.equal(d.commit, 'deadbeef42', 'sealed sha must come from git, not the agent claim');
  assert.equal(d.branch, 'agent-12345678', 'sealed branch must come from git, not the agent claim');
});

test('seal: legacy in-place run (cwd == project folder) is exempt', async () => {
  const slug = 'seal-inplace-legacy';
  const projectFolder = join(tmpDir, slug);
  const { p, contract, runId } = seedRepoRun(slug, projectFolder);
  // A dirty probe would refuse if the seal applied — it must not even run.
  let probed = false;
  const app = mkApp(
    receipts({
      workingTreeStatus: async () => {
        probed = true;
        return 'dirty';
      },
    }),
  );

  const res = await app.request(`/api/projects/${p.id}/agent-runs/${runId}/deliverable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliverable: { kind: 'repo', branch: 'human-managed' } }),
  });

  assert.equal(res.status, 200);
  assert.equal(probed, false, 'legacy in-place runs must not be gated by the seal');
  const c = getContract(contract.id as ULID);
  const d = c!.deliverable as { branch?: string };
  assert.equal(d.branch, 'human-managed', 'deliverable passes through unstamped');
});
