// Regression test for pc-pty-chat-369: continuation spawns in parent's
// worktreeDir, not project.folderPath.
//
// Root cause: dispatchContinueAgent used input.worktreeDir, which all 3 call
// sites set to project.folderPath. CC resolves --resume sessions by slugifying
// cwd, so a worktree-bound run spawned in project.folderPath → wrong slug →
// "No conversation found" → unexpected-exit.
//
// Fix: continueAgent returns worktreeDir in the plan; dispatchContinueAgent
// uses plan.plan.worktreeDir; no caller can supply the wrong value.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-continue-cwd-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  runMigrations,
  createProject,
  createAgent,
  insertAgentRunRow,
  newId,
} = await import('@pc/db');
const { continueAgent } = await import('../src/services/pause-resume.ts');

import type { ULID } from '@pc/domain';

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

let projectId: ULID;
let projectFolderPath: string;

before(() => {
  runMigrations();

  projectFolderPath = join(tmpDir, 'main-repo');
  mkdirSync(projectFolderPath, { recursive: true });

  const project = createProject({
    slug: 'cwd-test-' + Date.now(),
    name: 'CWD Test',
    stages,
    folderPath: projectFolderPath,
  });
  projectId = project.id as ULID;

  createAgent(
    {
      id: newId(),
      scope: 'global',
      name: 'code-writer',
      prompt: 'You write code.',
      tools: [],
      description: 'Code writer',
    },
    { actor: 'orchestrator', reason: 'test seed' },
  );
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('continuation plan carries parent worktreeDir, not project.folderPath', () => {
  // A worktree-bound parent run — the worktreeDir is a dedicated path that
  // is NOT project.folderPath.
  const worktreePath = join(tmpDir, 'worktrees', 'code-writer-abc123');
  mkdirSync(worktreePath, { recursive: true });

  // Synthesise the JSONL path CC would have written so the retention guard
  // passes. The path is ~/.claude/projects/<slugified-cwd>/... but we can
  // override the existence check via the jsonlExists dep.
  const parentRunId = newId() as ULID;
  insertAgentRunRow({
    id: parentRunId,
    projectId,
    podName: 'code-writer',
    dispatcherSessionId: 'orch-cwd-test',
    ccSessionId: 'cc-cwd-test',
    status: 'completed',
    input: 'do the work',
    // Worktree dir stored on the parent row.
    worktreeDir: worktreePath,
    queuedAt: Date.now(),
  });

  const result = continueAgent(
    { parentAgentRunId: parentRunId, input: 'address the feedback' },
    // Bypass the JSONL file-system check — we only care about the plan cwd.
    { jsonlExists: () => true },
  );

  assert.ok(result.ok, 'continueAgent must succeed: ' + (result.ok ? '' : result.error));
  assert.equal(
    result.plan.worktreeDir,
    worktreePath,
    'plan.worktreeDir must equal the parent run worktreeDir, not project.folderPath',
  );
  assert.notEqual(
    result.plan.worktreeDir,
    projectFolderPath,
    'plan.worktreeDir must NOT be project.folderPath',
  );
});

test('continuation plan falls back to project.folderPath for legacy runs (null worktreeDir)', () => {
  // A legacy parent row with no worktreeDir stored (pre-dates the column).
  const parentRunId = newId() as ULID;
  insertAgentRunRow({
    id: parentRunId,
    projectId,
    podName: 'code-writer',
    dispatcherSessionId: 'orch-legacy-test',
    ccSessionId: 'cc-legacy-test',
    status: 'completed',
    input: 'do the work',
    // No worktreeDir — simulates legacy row.
    queuedAt: Date.now(),
  });

  const result = continueAgent(
    { parentAgentRunId: parentRunId, input: 'address the feedback' },
    { jsonlExists: () => true },
  );

  assert.ok(result.ok, 'continueAgent must succeed: ' + (result.ok ? '' : result.error));
  assert.equal(
    result.plan.worktreeDir,
    projectFolderPath,
    'plan.worktreeDir must fall back to project.folderPath for legacy rows',
  );
});
