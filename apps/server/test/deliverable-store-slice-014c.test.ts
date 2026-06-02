// Slice 014c — the `store` EXECUTOR + per-store acceptance criteria.
//
// The writer-vs-reader-mismatch class of bug (a recurring pattern in this
// codebase): the deliverable was written to the contract row, but verification
// read the work-item body — two different places, nothing bridging them. These
// round-trips assert, for EVERY prose store + for explicit-submit answer, that
// submission ALONE writes the declared home AND passes verification.

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
        body: 'ORIGINAL task brief — must be overwritten by the deliverable',
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

test('prose/work_item_body: submit writes the WI body AND passes verification', async () => {
  const expected: ContractV2.ExpectedOutput = {
    kind: 'prose',
    store: 'work_item_body',
    sections: SECTIONS,
    min_chars: 50,
  };
  const { p, wi, contract, runId } = seed('wib', expected, { withWorkItem: true });
  const app = mkApp();

  const res = await submit(app, p.id, runId, { kind: 'prose', text: SPEC_TEXT });
  assert.equal(res.status, 200);

  // The body is now the deliverable, not the original brief.
  assert.equal(getWorkItem(wi!.id)!.body, SPEC_TEXT);

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

test('answer (explicit submit, no report): passes via the deliverable-text fallback', async () => {
  const expected: ContractV2.ExpectedOutput = {
    kind: 'answer',
    must_address: ['latency', 'cost'],
  };
  const { p, contract, runId } = seed('ans', expected, { withWorkItem: false });
  const app = mkApp();

  // The answer text carries the topics; the agent passes NO separate report.
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
  assert.equal(outcome!.verificationStatus, 'passed');
});

test('placement failure: prose/work_item_body with no linked WI returns 422 (retryable)', async () => {
  const expected: ContractV2.ExpectedOutput = {
    kind: 'prose',
    store: 'work_item_body',
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
