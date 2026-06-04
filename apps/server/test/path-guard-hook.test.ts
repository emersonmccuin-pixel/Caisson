// path-guard.cjs enforcement tests (2026-06-03 incident).
//
// The hook runs side effects at module top level (reads stdin, process.exit),
// so every case spawns it as a real subprocess — exactly how claude.exe runs
// it — with a synthetic PreToolUse payload on stdin + spawn-shaped env vars.
//
// Locks in three things:
//   1. THE REGRESSION: CC ≥2.1 sets payload.agent_type on the MAIN thread of
//      --agent sessions; the old hook read that as "subagent", found no
//      binding, and silently skipped ALL enforcement for workflow agents.
//   2. THE BLIND SPOT: Git-Bash form absolute paths (/e/…) sailed past the
//      Windows-only drive-letter regex.
//   3. THE GIT WRITE FENCE: writing git aimed outside the session's fence
//      root is denied for every PC session (orchestrator included); read-only
//      git passes anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const HOOK = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', '..', '..', 'templates', '.claude', 'hooks', 'path-guard.cjs',
);

const WT = 'E:/Claude Code Projects/Personal/PC-PTY-Chat/data/worktrees/pc-pty-chat/wf-TEST1234';
const REPO = 'E:/Claude Code Projects/Personal/PC-PTY-Chat';

interface RunResult {
  denied: boolean;
  reason: string;
}

function runEnforce(payload: Record<string, unknown>, env: Record<string, string>): RunResult {
  const res = spawnSync(process.execPath, [HOOK, 'enforce'], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, PC_WORKFLOW_RUN_ID: '', PC_WORKFLOW_WORKTREE: '', PC_PROJECT_ID: '', ...env },
    timeout: 15_000,
  });
  const out = (res.stdout ?? '').trim();
  if (!out) return { denied: false, reason: '' };
  const parsed = JSON.parse(out) as { decision?: string; reason?: string };
  return { denied: parsed.decision === 'block', reason: parsed.reason ?? '' };
}

function bash(command: string, cwd = WT): Record<string, unknown> {
  return { tool_name: 'Bash', tool_input: { command }, cwd, agent_type: 'code-writer' };
}

const WORKFLOW_ENV = {
  PC_PROJECT_ID: 'P01',
  PC_WORKFLOW_RUN_ID: 'run1',
  PC_WORKFLOW_WORKTREE: WT,
};

// ── 1. the silent-skip regression ────────────────────────────────────────────

test('REGRESSION: main-thread agent_type must NOT disable workflow enforcement', () => {
  // agent_type set (CC ≥2.1 main-thread) + workflow env + out-of-worktree path.
  // The old hook took the subagent branch, found no binding, skipped → allowed.
  const r = runEnforce(
    bash(`cd "${REPO}" && git reset HEAD~1`),
    WORKFLOW_ENV,
  );
  assert.equal(r.denied, true, 'must deny despite agent_type being set');
});

test('workflow agent: out-of-worktree drive-letter path denied', () => {
  const r = runEnforce(bash(`cat "${REPO}/AGENTS.md"`), WORKFLOW_ENV);
  assert.equal(r.denied, true);
  assert.match(r.reason, /Out-of-worktree/);
});

test('BLIND SPOT: Git-Bash form (/e/…) out-of-worktree path denied', () => {
  // Yesterday's first misplaced write used exactly this form.
  const r = runEnforce(
    bash(`cat > "/e/Claude Code Projects/Personal/PC-PTY-Chat/docs/oops.md" <<'EOF'\nhi\nEOF`),
    WORKFLOW_ENV,
  );
  assert.equal(r.denied, true);
});

test('workflow agent: in-worktree work (incl. git commit) passes', () => {
  const r = runEnforce(
    bash(`cd "${WT}" && git add docs/x.md && git commit -m "ok"`),
    WORKFLOW_ENV,
  );
  assert.equal(r.denied, false, r.reason);
});

test('workflow agent: Edit outside worktree denied, inside allowed', () => {
  const outside = runEnforce(
    { tool_name: 'Edit', tool_input: { file_path: `${REPO}/package.json` }, cwd: WT, agent_type: 'code-writer' },
    WORKFLOW_ENV,
  );
  assert.equal(outside.denied, true);
  const inside = runEnforce(
    { tool_name: 'Edit', tool_input: { file_path: `${WT}/docs/x.md` }, cwd: WT, agent_type: 'code-writer' },
    WORKFLOW_ENV,
  );
  assert.equal(inside.denied, false);
});

// ── 2. the git write fence (every PC session) ────────────────────────────────

const ORCH_ENV = { PC_PROJECT_ID: 'P01' }; // orchestrator: no workflow env

test('git fence: orchestrator cd-to-outside + git reset denied', () => {
  const r = runEnforce(
    { tool_name: 'Bash', tool_input: { command: `cd "C:/Users/someone/other-repo" && git reset --hard` }, cwd: REPO },
    ORCH_ENV,
  );
  assert.equal(r.denied, true);
  assert.match(r.reason, /git reset/);
});

test('git fence: git -C <outside> commit denied; -C <inside> allowed', () => {
  const out = runEnforce(
    { tool_name: 'Bash', tool_input: { command: `git -C "C:/elsewhere/repo" commit -m hi` }, cwd: REPO },
    ORCH_ENV,
  );
  assert.equal(out.denied, true);
  const inn = runEnforce(
    { tool_name: 'Bash', tool_input: { command: `git -C "${REPO}/packages" commit -m hi` }, cwd: REPO },
    ORCH_ENV,
  );
  assert.equal(inn.denied, false, inn.reason);
});

test('git fence: read-only git outside the fence passes', () => {
  const r = runEnforce(
    { tool_name: 'Bash', tool_input: { command: `git -C "C:/elsewhere/repo" log --oneline -3` }, cwd: REPO },
    ORCH_ENV,
  );
  assert.equal(r.denied, false, r.reason);
});

test('git fence: in-fence git write passes (orchestrator in its project)', () => {
  const r = runEnforce(
    { tool_name: 'Bash', tool_input: { command: `git add -A && git commit -m "fix"` }, cwd: REPO },
    ORCH_ENV,
  );
  assert.equal(r.denied, false, r.reason);
});

test("git fence: yesterday's exact misplaced-commit command denied for a workflow agent", () => {
  const r = runEnforce(
    bash(`cd "/e/Claude Code Projects/Personal/PC-PTY-Chat" && git add docs/workflow-file-then-review.md && git commit -m "docs"`),
    WORKFLOW_ENV,
  );
  assert.equal(r.denied, true);
});

test('git fence: cd carries across && segments into the git call', () => {
  const r = runEnforce(
    bash(`cd "${REPO}" && git status && git checkout -- .`),
    WORKFLOW_ENV,
  );
  assert.equal(r.denied, true, 'checkout in the cd-target (outside worktree) must deny');
});

// ── 3. exemptions ─────────────────────────────────────────────────────────────

test('outer/dev session (no PC_PROJECT_ID): everything passes', () => {
  const r = runEnforce(
    { tool_name: 'Bash', tool_input: { command: `cd "C:/anywhere" && git reset --hard` }, cwd: REPO },
    {},
  );
  assert.equal(r.denied, false, r.reason);
});

test('non-git bash outside paths: fence does not fire (only full confinement does)', () => {
  // Orchestrator (no worktree binding) reading another folder is fine.
  const r = runEnforce(
    { tool_name: 'Bash', tool_input: { command: `dir "C:/Users/someone/Documents"` }, cwd: REPO },
    ORCH_ENV,
  );
  assert.equal(r.denied, false, r.reason);
});
