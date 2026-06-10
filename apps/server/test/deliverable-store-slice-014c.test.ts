// Slice 014c — the `store` EXECUTOR + per-store acceptance criteria.
//
// The writer-vs-reader-mismatch class of bug (a recurring pattern in this
// codebase): the deliverable was written to the contract row, but verification
// read a different corpus — two different places, nothing bridging them. These
// round-trips assert, for EVERY prose store + for explicit-submit answer, that
// submission ALONE writes the declared home AND passes verification.
//
// M5 (FD-5) — ☠ `store: 'work_item_body'`: the WI body is the human brief only;
// the default store is `contract`. The first test pins the body's survival.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-store-014c-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createWorkItem,
  getWorkItem,
  listAttachmentsForWorkItem,
  insertAgentRunRow,
  newId,
} = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');
const { deriveAcceptanceCriteriaV2, proseAttachmentName } = await import('@pc/domain');

import type { Stage, ULID, ContractV2 } from '@pc/domain';
import { registerAgentRunRoutes } from '../src/features/agent-runs/routes.ts';
import { runVerificationOnTerminal } from '../src/services/agent-verification.ts';

const stages: Stage[] = [{ id: 'backlog', name: 'Backlog', order: 0 }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkProject(slug: string) {
  return createProject({ slug, name: slug, stages, folderPath: join(tmpDir, slug) });
}

function mkApp(): Hono {
  const app = new Hono();
  registerAgentRunRoutes(app, {
    broadcastTo: () => {},
    getActiveRunRegistry: () => ({ get: () => null }),
  });
  return app;
}

/** Seed a project (+ optional WI) and a dispatched contract carrying the
 *  expected output and its DERIVED acceptance criteria — exactly what dispatch
 *  mints in production. */
function seed(
  slug: string,
  expectedOutput: ContractV2.ExpectedOutput,
  opts: { withWorkItem?: boolean; worktreePath?: string } = {},
) {
  const p = mkProject(slug);
  const wi = opts.withWorkItem
    ? createWorkItem({
        projectId: p.id as ULID,
        stageId: 'backlog',
        title: 'task',
        body: 'ORIGINAL task brief — must SURVIVE delivery untouched (M5: body = brief only)',
      })
    : null;
  const contract = new ContractService().create({
    projectId: p.id as ULID,
    workItemId: wi?.id ?? null,
    podName: 'researcher',
    expectedOutput,
    acceptanceCriteria: deriveAcceptanceCriteriaV2(expectedOutput),
    ...(opts.worktreePath !== undefined ? { worktreePath: opts.worktreePath } : {}),
  });
  const runId = newId() as ULID;
  insertAgentRunRow({
    id: runId,
    projectId: p.id as ULID,
    podName: 'researcher',
    dispatcherSessionId: 's',
    ccSessionId: 'cc',
    status: 'running',
    input: 'go',
    ...(wi ? { parentWorkItemId: wi.id } : {}),
    contractId: contract.id as ULID,
    queuedAt: Date.now(),
  });
  return { p, wi, contract, runId };
}

async function submit(app: Hono, projectId: string, runId: string, deliverable: unknown, report?: string) {
  return app.request(`/api/projects/${projectId}/agent-runs/${runId}/deliverable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliverable, ...(report !== undefined ? { report } : {}) }),
  });
}

async function verify(input: {
  contractId: string;
  worktreeDir: string;
  projectFolderPath: string;
}) {
  return runVerificationOnTerminal(
    {
      contractId: input.contractId as ULID,
      terminalStatus: 'completed',
      failureReason: null,
      projectFolderPath: input.projectFolderPath,
      worktreeDir: input.worktreeDir,
      project: null,
    },
    {},
  );
}

const SECTIONS = ['Current state', 'Concrete proposal'];
const SPEC_TEXT =
  '# Spec\n\n## Current state\nThings are as they are, described at length here.\n\n' +
  '## Concrete proposal\nDo the thing, described at length here so we clear min_chars.';

test('prose/default store (M5): WI body stays the BRIEF; deliverable passes on the contract', async () => {
  // store unset → defaults to 'contract' (FD-5/M5) even with a WI linked.
  const expected: ContractV2.ExpectedOutput = {
    kind: 'prose',
    sections: SECTIONS,
    min_chars: 50,
  };
  const { p, wi, contract, runId } = seed('wib', expected, { withWorkItem: true });
  const app = mkApp();

  const res = await submit(app, p.id, runId, { kind: 'prose', text: SPEC_TEXT });
  assert.equal(res.status, 200);

  // M5 law: the body is the human brief only — the deliverable never lands there.
  assert.equal(
    getWorkItem(wi!.id)!.body,
    'ORIGINAL task brief — must SURVIVE delivery untouched (M5: body = brief only)',
  );

  const outcome = await verify({
    contractId: contract.id,
    worktreeDir: join(tmpDir, 'wib'),
    projectFolderPath: p.folderPath,
  });
  assert.equal(outcome!.verificationStatus, 'passed');
});

test('prose/attachment: submit creates the attachment AND passes verification', async () => {
  const expected: ContractV2.ExpectedOutput = {
    kind: 'prose',
    doc_type: 'spec',
    store: 'attachment',
    sections: SECTIONS,
    min_chars: 50,
  };
  const { p, wi, contract, runId } = seed('att', expected, { withWorkItem: true });
  const app = mkApp();

  const res = await submit(app, p.id, runId, { kind: 'prose', text: SPEC_TEXT });
  assert.equal(res.status, 200);

  const atts = listAttachmentsForWorkItem(wi!.id);
  assert.equal(atts.length, 1);
  assert.equal(atts[0]!.name, proseAttachmentName(expected as never));
  assert.equal(atts[0]!.content, SPEC_TEXT);

  const outcome = await verify({
    contractId: contract.id,
    worktreeDir: join(tmpDir, 'att'),
    projectFolderPath: p.folderPath,
  });
  assert.equal(outcome!.verificationStatus, 'passed');
});

test('prose/contract: submit (no separate report) passes via the deliverable-text fallback', async () => {
  const expected: ContractV2.ExpectedOutput = {
    kind: 'prose',
    store: 'contract',
    sections: SECTIONS,
    min_chars: 50,
  };
  const { p, contract, runId } = seed('con', expected, { withWorkItem: false });
  const app = mkApp();

  // No `report` field — the prose lives only on deliverable.text.
  const res = await submit(app, p.id, runId, { kind: 'prose', text: SPEC_TEXT });
  assert.equal(res.status, 200);

  const outcome = await verify({
    contractId: contract.id,
    worktreeDir: join(tmpDir, 'con'),
    projectFolderPath: p.folderPath,
  });
  assert.equal(outcome!.verificationStatus, 'passed');
});

test('prose/repo_file: submit writes the file AND passes verification', async () => {
  const wt = join(tmpDir, 'repo-wt');
  const expected: ContractV2.ExpectedOutput = {
    kind: 'prose',
    store: 'repo_file',
    path: 'docs/out.md',
    min_chars: 10,
  };
  const { p, contract, runId } = seed('repo', expected, { worktreePath: wt });
  const app = mkApp();

  const res = await submit(app, p.id, runId, { kind: 'prose', text: SPEC_TEXT });
  assert.equal(res.status, 200);
  assert.equal(readFileSync(join(wt, 'docs/out.md'), 'utf8'), SPEC_TEXT);

  const outcome = await verify({
    contractId: contract.id,
    worktreeDir: wt,
    projectFolderPath: p.folderPath,
  });
  assert.equal(outcome!.verificationStatus, 'passed');
});

test('answer (must_address-only, no trust_end_turn): escalates to review after soundness fix (pc-pty-chat-371)', async () => {
  // must_address[] is now agent guidance only — no longer compiled to
  // report_contains predicates. The derived AC is therefore empty. An empty-AC
  // answer without trust_end_turn escalates to review (pending), not auto-pass.
  const expected: ContractV2.ExpectedOutput = {
    kind: 'answer',
    must_address: ['latency', 'cost'],
  };
  const { p, contract, runId } = seed('ans', expected, { withWorkItem: false });
  const app = mkApp();

  // Submission itself still succeeds.
  const res = await submit(app, p.id, runId, {
    kind: 'answer',
    text: 'On latency we are fine; on cost we are under budget.',
  });
  assert.equal(res.status, 200);

  const outcome = await verify({
    contractId: contract.id,
    worktreeDir: join(tmpDir, 'ans'),
    projectFolderPath: p.folderPath,
  });
  // Honest outcome: empty decidable set + no trust_end_turn → escalated to review.
  assert.equal(outcome!.verificationStatus, 'pending');
});

test('placement failure: prose/attachment with no linked WI returns 422 (retryable)', async () => {
  const expected: ContractV2.ExpectedOutput = {
    kind: 'prose',
    store: 'attachment',
    sections: SECTIONS,
  };
  const { p, runId } = seed('nowi', expected, { withWorkItem: false });
  const app = mkApp();

  const res = await submit(app, p.id, runId, { kind: 'prose', text: SPEC_TEXT });
  assert.equal(res.status, 422);
  const body = (await res.json()) as { cause: string };
  assert.equal(body.cause, 'store-target-missing');
});

test('placement failure: repo_file path escaping the base returns 422', async () => {
  const expected: ContractV2.ExpectedOutput = {
    kind: 'prose',
    store: 'repo_file',
    path: '../escape.md',
  };
  const { p, runId } = seed('escape', expected, { worktreePath: join(tmpDir, 'escape-wt') });
  const app = mkApp();

  const res = await submit(app, p.id, runId, { kind: 'prose', text: SPEC_TEXT });
  assert.equal(res.status, 422);
  const body = (await res.json()) as { cause: string };
  assert.equal(body.cause, 'store-path-invalid');
});
