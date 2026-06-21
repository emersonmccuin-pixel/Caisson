// pc-pty-chat-270 Chunk A — runtime git primitive tests.
//
// Verifies `gitMergeState`, `mergeBranchIntoHead`, `pushBranch`,
// `ensureMergeWorktree`, `branchMergedInto`, and `detectIntegrationBranch`
// against throwaway temp git repos without touching the real project repo.
//
// Two fixtures: a `dev`-named integration repo (the historical default) and a
// `trunk`-named one (proves nothing assumes the literal 'dev' anymore).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  branchMergedInto,
  createWorktree,
  detectIntegrationBranch,
  ensureMergeWorktree,
  fastForwardWorktree,
  getWorktreeStatus,
  gitMergeState,
  mergeBranchIntoHead,
  pushBranch,
  resolveIntegrationTip,
  resolveLocalBranchHead,
  updateRef,
} from '../src/worktree.ts';

let repoDir: string;
let originDir: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
}
function gitOut(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir }).toString().trim();
}
function gitOrigin(...args: string[]): void {
  execFileSync('git', args, { cwd: originDir, stdio: 'ignore' });
}

before(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'pc-merge-repo-'));
  originDir = mkdtempSync(join(tmpdir(), 'pc-merge-origin-'));

  // Set up bare "origin"
  gitOrigin('init', '--bare');

  // Set up the main repo
  git('init');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');

  // Initial commit then rename to dev
  writeFileSync(join(repoDir, 'base.txt'), 'base\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  git('branch', '-m', 'dev');

  // Set up origin
  git('remote', 'add', 'origin', originDir);

  // feature-clean: adds a new file (no conflict with dev)
  git('checkout', '-b', 'feature-clean');
  writeFileSync(join(repoDir, 'feature.txt'), 'new feature\n');
  git('add', '.');
  git('commit', '-m', 'add feature.txt');
  git('checkout', 'dev');

  // feature-conflict: modifies shared.txt; dev also modifies it → conflict
  git('checkout', '-b', 'feature-conflict');
  writeFileSync(join(repoDir, 'shared.txt'), 'branch-version\n');
  git('add', '.');
  git('commit', '-m', 'shared.txt on branch');
  git('checkout', 'dev');
  writeFileSync(join(repoDir, 'shared.txt'), 'dev-version\n');
  git('add', '.');
  git('commit', '-m', 'shared.txt on dev');
});

after(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(originDir, { recursive: true, force: true });
});

test('gitMergeState: initial state — not merged, no conflict, not pushed', async () => {
  const state = await gitMergeState(repoDir, 'feature-clean', 'dev');
  assert.equal(state.alreadyMerged, false, 'not yet merged');
  assert.equal(state.mergeInProgress, false, 'no merge in progress');
  assert.equal(state.pushed, false, 'not pushed yet');
});

test('branchMergedInto: false before merge, true after', async () => {
  assert.equal(await branchMergedInto(repoDir, 'feature-clean', 'dev'), false);
});

test('mergeBranchIntoHead: clean merge succeeds', async () => {
  await assert.doesNotReject(
    () => mergeBranchIntoHead(repoDir, 'feature-clean'),
    'clean merge must not throw',
  );
});

test('gitMergeState: alreadyMerged=true after clean merge', async () => {
  const state = await gitMergeState(repoDir, 'feature-clean', 'dev');
  assert.equal(state.alreadyMerged, true, 'branch tip is now an ancestor of dev');
  assert.equal(state.mergeInProgress, false, 'no lingering MERGE_HEAD');
  assert.equal(await branchMergedInto(repoDir, 'feature-clean', 'dev'), true);
});

test('mergeBranchIntoHead: conflicting merge throws', async () => {
  await assert.rejects(
    () => mergeBranchIntoHead(repoDir, 'feature-conflict'),
    'conflicting merge must throw',
  );
});

test('gitMergeState: mergeInProgress=true during a conflict', async () => {
  const state = await gitMergeState(repoDir, 'feature-conflict', 'dev');
  assert.equal(state.mergeInProgress, true, 'MERGE_HEAD must be present after conflict');
  assert.equal(state.alreadyMerged, false, 'conflicted branch is not yet merged');
});

test('gitMergeState: mergeInProgress=false after aborting the conflict', async () => {
  git('merge', '--abort');
  const state = await gitMergeState(repoDir, 'feature-conflict', 'dev');
  assert.equal(state.mergeInProgress, false, 'MERGE_HEAD must be gone after abort');
});

test('pushBranch + gitMergeState: pushed=true after push', async () => {
  await pushBranch(repoDir, 'dev');
  const state = await gitMergeState(repoDir, 'feature-clean', 'dev');
  assert.equal(state.pushed, true, 'origin/dev should match local dev after push');
});

// ── ensureMergeWorktree ──────────────────────────────────────────────────────

let mergeWtDir: string;

test('ensureMergeWorktree: creates a detached-HEAD worktree at the integration tip', async () => {
  mergeWtDir = mkdtempSync(join(tmpdir(), 'pc-merge-wt-'));
  const wtPath = join(mergeWtDir, 'dev-merge');

  await assert.doesNotReject(
    () => ensureMergeWorktree(repoDir, wtPath, 'dev'),
    'ensureMergeWorktree must not throw for a clean creation',
  );

  const status = await getWorktreeStatus(wtPath);
  assert.equal(status.branch, null, 'merge worktree is in detached HEAD (--detach mode)');
  assert.equal(status.clean, true, 'freshly created merge worktree must be clean');
});

test('ensureMergeWorktree: idempotent — reuses an up-to-date detached worktree', async () => {
  const wtPath = join(mergeWtDir, 'dev-merge');
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath })
    .toString()
    .trim();
  await assert.doesNotReject(() => ensureMergeWorktree(repoDir, wtPath, 'dev'));
  const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath })
    .toString()
    .trim();
  assert.equal(headAfter, headBefore, 'up-to-date worktree must be reused, not recreated');
});

test('ensureMergeWorktree: LINEAGE GUARD — stale worktree is recreated at the new tip', async () => {
  const wtPath = join(mergeWtDir, 'dev-merge');
  // Advance dev in the main checkout (an out-of-band merge / commit).
  writeFileSync(join(repoDir, 'advance.txt'), 'moved on\n');
  git('add', '.');
  git('commit', '-m', 'advance dev past the merge worktree');
  const devTip = gitOut('rev-parse', 'dev');

  await ensureMergeWorktree(repoDir, wtPath, 'dev');
  const wtHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath }).toString().trim();
  assert.equal(wtHead, devTip, 'stale worktree must be recreated at the current dev tip');
});

test('ensureMergeWorktree: MERGE_HEAD guard — a parked conflict is never destroyed', async () => {
  const wtPath = join(mergeWtDir, 'dev-merge');
  // Park a conflict inside the merge worktree.
  try {
    execFileSync('git', ['merge', '--no-ff', 'feature-conflict'], { cwd: wtPath, stdio: 'ignore' });
  } catch {
    /* expected: conflict */
  }
  // Advance dev again so the worktree is ALSO stale — conflict must still win.
  writeFileSync(join(repoDir, 'advance2.txt'), 'moved on again\n');
  git('add', '.');
  git('commit', '-m', 'advance dev again');

  await ensureMergeWorktree(repoDir, wtPath, 'dev');
  assert.ok(
    existsSync(join(wtPath, 'shared.txt')),
    'worktree must survive (parked conflict state)',
  );
  const state = await gitMergeState(wtPath, 'feature-conflict', 'dev');
  assert.equal(state.mergeInProgress, true, 'MERGE_HEAD must still be present');
  execFileSync('git', ['merge', '--abort'], { cwd: wtPath, stdio: 'ignore' });
});

// ── non-dev integration branch (proves the literal is gone) ─────────────────

test('integration machinery works on a repo whose integration branch is "trunk"', async () => {
  const repo2 = mkdtempSync(join(tmpdir(), 'pc-trunk-repo-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo2, stdio: 'ignore' });
  try {
    g('init');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo2, 'a.txt'), 'a\n');
    g('add', '.');
    g('commit', '-m', 'initial');
    g('branch', '-m', 'trunk');
    g('checkout', '-b', 'agent-x');
    writeFileSync(join(repo2, 'b.txt'), 'b\n');
    g('add', '.');
    g('commit', '-m', 'work');
    g('checkout', 'trunk');

    assert.equal(await branchMergedInto(repo2, 'agent-x', 'trunk'), false);
    g('merge', '--no-ff', 'agent-x');
    assert.equal(await branchMergedInto(repo2, 'agent-x', 'trunk'), true);

    const state = await gitMergeState(repo2, 'agent-x', 'trunk');
    assert.equal(state.alreadyMerged, true);

    const wt = join(mkdtempSync(join(tmpdir(), 'pc-trunk-wt-')), 'merge');
    await ensureMergeWorktree(repo2, wt, 'trunk');
    const status = await getWorktreeStatus(wt);
    assert.equal(status.branch, null, 'detached at trunk tip');
  } finally {
    rmSync(repo2, { recursive: true, force: true });
  }
});

// ── cherry-pick (patch-equivalence) landing — the CIA-NEXT flow ─────────────

test('branchMergedInto: cherry-picked work counts as landed; un-picked commits do not', async () => {
  const repo3 = mkdtempSync(join(tmpdir(), 'pc-cherry-repo-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo3, stdio: 'ignore' });
  try {
    g('init', '-b', 'phase-branch');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo3, 'a.txt'), 'a\n');
    g('add', '.');
    g('commit', '-m', 'initial');

    // Agent branch with one commit.
    g('checkout', '-b', 'agent-cp');
    writeFileSync(join(repo3, 'work.txt'), 'agent work\n');
    g('add', '.');
    g('commit', '-m', 'agent work');
    const tip = execFileSync('git', ['rev-parse', 'agent-cp'], { cwd: repo3 }).toString().trim();

    // Integrate by CHERRY-PICK (not merge) — tip is NOT an ancestor.
    // Force GIT_COMMITTER_DATE to a fixed past date so the cherry-pick commit
    // always has a different SHA from the original (on fast machines both land
    // in the same second and produce identical SHAs, which breaks the D1b
    // SHA-guard in branchMergedInto).
    g('checkout', 'phase-branch');
    execFileSync('git', ['cherry-pick', tip], {
      cwd: repo3,
      stdio: 'ignore',
      env: { ...process.env, GIT_COMMITTER_DATE: 'Sat Jan 1 00:00:00 2000 +0000' },
    });

    assert.equal(
      await branchMergedInto(repo3, 'agent-cp', 'phase-branch'),
      true,
      'patch-equivalent (cherry-picked) work is landed — safe to reap',
    );

    // A second commit on the agent branch that was NEVER picked → kept.
    g('checkout', 'agent-cp');
    writeFileSync(join(repo3, 'more.txt'), 'unlanded\n');
    g('add', '.');
    g('commit', '-m', 'unlanded work');
    g('checkout', 'phase-branch');

    assert.equal(
      await branchMergedInto(repo3, 'agent-cp', 'phase-branch'),
      false,
      'any commit without an upstream equivalent keeps the branch',
    );
  } finally {
    rmSync(repo3, { recursive: true, force: true });
  }
});

// ── D1b: branchMergedInto fresh-branch fix (pc-pty-chat-440) ─────────────────

test('D1b: branchMergedInto — fresh branch at integration tip returns false (not merged)', async () => {
  // A branch forked from integration with 0 commits of its own must return
  // false — it was never merged, just created. Before D1b the is-ancestor
  // check returned true because the tip IS an ancestor (degenerate: of itself).
  const repo4 = mkdtempSync(join(tmpdir(), 'pc-d1b-fresh-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo4, stdio: 'ignore' });
  try {
    g('init', '-b', 'dev');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo4, 'base.txt'), 'base\n');
    g('add', '.');
    g('commit', '-m', 'initial');

    // Fresh branch — 0 commits ahead of dev.
    g('checkout', '-b', 'agent-fresh');
    g('checkout', 'dev');

    assert.equal(
      await branchMergedInto(repo4, 'agent-fresh', 'dev'),
      false,
      'D1b: fresh branch at integration tip must NOT be considered merged',
    );

    // Add a commit to the agent branch, then merge — THEN it must be true.
    g('checkout', 'agent-fresh');
    writeFileSync(join(repo4, 'work.txt'), 'agent work\n');
    g('add', '.');
    g('commit', '-m', 'agent work');
    g('checkout', 'dev');
    g('merge', '--no-ff', 'agent-fresh');

    assert.equal(
      await branchMergedInto(repo4, 'agent-fresh', 'dev'),
      true,
      'D1b: after merge, branch must be considered merged',
    );
  } finally {
    rmSync(repo4, { recursive: true, force: true });
  }
});

// ── detectIntegrationBranch ──────────────────────────────────────────────────

test('detectIntegrationBranch: prefers a local dev branch', async () => {
  assert.equal(await detectIntegrationBranch(repoDir), 'dev');
});

test('detectIntegrationBranch: falls back to origin/HEAD, then current branch', async () => {
  const repo2 = mkdtempSync(join(tmpdir(), 'pc-detect-repo-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo2, stdio: 'ignore' });
  try {
    g('init', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo2, 'a.txt'), 'a\n');
    g('add', '.');
    g('commit', '-m', 'initial');

    // No dev, no origin → current branch.
    assert.equal(await detectIntegrationBranch(repo2), 'main');

    // Simulate a clone's origin/HEAD pointing at main while checked out elsewhere.
    g('checkout', '-b', 'work-branch');
    assert.equal(await detectIntegrationBranch(repo2), 'work-branch');
  } finally {
    rmSync(repo2, { recursive: true, force: true });
  }
});

// ── getWorktreeStatus ────────────────────────────────────────────────────────

test('getWorktreeStatus: returns branch=dev and clean=true on the main repo', async () => {
  const status = await getWorktreeStatus(repoDir);
  assert.equal(status.branch, 'dev', 'main repo is on dev');
  assert.equal(status.clean, true, 'main repo is clean (no pending changes)');
});

test('resolveLocalBranchHead: returns local branch SHA and ignores missing branches', async () => {
  const sha = gitOut('rev-parse', 'dev');
  assert.equal(await resolveLocalBranchHead(repoDir, 'dev'), sha);
  assert.equal(await resolveLocalBranchHead(repoDir, 'missing-branch'), null);
});

test('fastForwardWorktree: fast-forwards a checked-out local branch', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'pc-ff-wt-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  const out = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim();
  try {
    g('init');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    g('add', '.');
    g('commit', '-m', 'base');
    g('branch', '-m', 'main');
    const base = out('rev-parse', 'HEAD');
    g('checkout', '-b', 'ahead');
    writeFileSync(join(repo, 'b.txt'), 'ahead\n');
    g('add', '.');
    g('commit', '-m', 'ahead');
    const ahead = out('rev-parse', 'HEAD');
    g('checkout', 'main');
    assert.equal(out('rev-parse', 'HEAD'), base);

    await fastForwardWorktree(repo, ahead);

    assert.equal(out('rev-parse', 'HEAD'), ahead);
    assert.equal((await getWorktreeStatus(repo)).branch, 'main');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── createWorktree: startPoint (pc-pty-chat-417) ─────────────────────────────

test('createWorktree: without startPoint forks from HEAD', async () => {
  const wtDir = mkdtempSync(join(tmpdir(), 'pc-create-wt-'));
  const wtPath = join(wtDir, 'no-startpoint');
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })
    .toString()
    .trim();
  try {
    const entry = await createWorktree(repoDir, wtPath, 'test-no-sp');
    const wtHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath }).toString().trim();
    assert.equal(wtHead, headBefore, 'no startPoint → forks from main checkout HEAD');
    assert.equal(entry.branch, 'test-no-sp');
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoDir, stdio: 'ignore' }); } catch { /* best-effort */ }
    try { execFileSync('git', ['branch', '-D', 'test-no-sp'], { cwd: repoDir, stdio: 'ignore' }); } catch { /* best-effort */ }
    rmSync(wtDir, { recursive: true, force: true });
  }
});

test('createWorktree: startPoint makes the new branch fork from that commit, not HEAD', async () => {
  // The startPoint is feature-clean's tip (which is BEHIND dev after the merge
  // ran in the earlier tests). The new branch must start there, not at dev HEAD.
  const featureTip = execFileSync('git', ['rev-parse', 'feature-clean'], { cwd: repoDir })
    .toString()
    .trim();
  const devHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();
  assert.notEqual(featureTip, devHead, 'pre-condition: feature-clean tip != dev HEAD');

  const wtDir = mkdtempSync(join(tmpdir(), 'pc-create-sp-'));
  const wtPath = join(wtDir, 'with-startpoint');
  try {
    const entry = await createWorktree(repoDir, wtPath, 'test-with-sp', featureTip);
    const wtHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath }).toString().trim();
    assert.equal(wtHead, featureTip, 'with startPoint → forks from the specified commit');
    assert.notEqual(wtHead, devHead, 'must NOT fork from main checkout HEAD');
    assert.equal(entry.branch, 'test-with-sp');
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoDir, stdio: 'ignore' }); } catch { /* best-effort */ }
    try { execFileSync('git', ['branch', '-D', 'test-with-sp'], { cwd: repoDir, stdio: 'ignore' }); } catch { /* best-effort */ }
    rmSync(wtDir, { recursive: true, force: true });
  }
});

// ── resolveIntegrationTip (pc-pty-chat-417) ──────────────────────────────────

test('resolveIntegrationTip: returns null for a repo with no resolvable refs', async () => {
  const repo4 = mkdtempSync(join(tmpdir(), 'pc-tip-empty-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo4, stdio: 'ignore' });
  try {
    g('init', '-b', 'dev');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    // Nothing committed — no HEAD, no integration branch yet.
    const tip = await resolveIntegrationTip(repo4, 'dev');
    assert.equal(tip, null, 'empty repo with no commits → null');
  } finally {
    rmSync(repo4, { recursive: true, force: true });
  }
});

test('resolveIntegrationTip: returns local integration tip when only local exists', async () => {
  // repoDir has dev but (since tests run serially) no merge-wt arg here.
  const tip = await resolveIntegrationTip(repoDir, 'dev');
  const devSha = execFileSync('git', ['rev-parse', 'dev'], { cwd: repoDir }).toString().trim();
  assert.equal(tip, devSha, 'only local branch → returns its SHA');
});

test('resolveIntegrationTip: returns origin tip (most-advanced) when it is ahead of local', async () => {
  // Build two repos where origin/dev is ahead of the local dev branch.
  // Setup: bare upstream → downstream clone (local+origin at C0) → push C1
  // from upstream directly → downstream fetches (origin/dev=C1, local dev=C0).
  const upstream = mkdtempSync(join(tmpdir(), 'pc-tip-upstream-'));
  const downstream = mkdtempSync(join(tmpdir(), 'pc-tip-downstream-'));
  const gd = (...args: string[]) => execFileSync('git', args, { cwd: downstream, stdio: 'ignore' });
  try {
    // Seed bare upstream with an initial commit via a temp working tree, then
    // clone downstream from it so both local dev and origin/dev start at C0.
    const seedDir = mkdtempSync(join(tmpdir(), 'pc-tip-seed-'));
    const gs = (...args: string[]) => execFileSync('git', args, { cwd: seedDir, stdio: 'ignore' });
    try {
      gs('init', '--bare', '-b', 'dev');
      const seedWork = mkdtempSync(join(tmpdir(), 'pc-tip-seedwork-'));
      const gw = (...args: string[]) => execFileSync('git', args, { cwd: seedWork, stdio: 'ignore' });
      try {
        gw('init', '-b', 'dev');
        gw('config', 'user.email', 't@t');
        gw('config', 'user.name', 't');
        gw('config', 'commit.gpgsign', 'false');
        writeFileSync(join(seedWork, 'base.txt'), 'base\n');
        gw('add', '.');
        gw('commit', '-m', 'initial');
        gw('remote', 'add', 'origin', seedDir);
        gw('push', 'origin', 'dev');
      } finally {
        rmSync(seedWork, { recursive: true, force: true });
      }
      // Clone downstream from the bare repo (now has local dev = origin/dev = C0).
      execFileSync('git', ['clone', seedDir, downstream], { stdio: 'ignore' });
      gd('config', 'user.email', 't@t');
      gd('config', 'user.name', 't');
      gd('config', 'commit.gpgsign', 'false');

      // Add C1 to upstream via another worker clone, then fetch in downstream.
      const landWork = mkdtempSync(join(tmpdir(), 'pc-tip-land-'));
      const gl = (...args: string[]) => execFileSync('git', args, { cwd: landWork, stdio: 'ignore' });
      try {
        execFileSync('git', ['clone', seedDir, landWork], { stdio: 'ignore' });
        gl('config', 'user.email', 't@t');
        gl('config', 'user.name', 't');
        gl('config', 'commit.gpgsign', 'false');
        writeFileSync(join(landWork, 'landed.txt'), 'landed\n');
        gl('add', '.');
        gl('commit', '-m', 'landing commit C1');
        gl('push', 'origin', 'dev');
      } finally {
        rmSync(landWork, { recursive: true, force: true });
      }

      // downstream: fetch only (local dev stays at C0, origin/dev advances to C1).
      gd('fetch', 'origin');
    } finally {
      rmSync(seedDir, { recursive: true, force: true });
    }

    const localSha = execFileSync('git', ['rev-parse', 'dev'], { cwd: downstream }).toString().trim();
    const originSha = execFileSync('git', ['rev-parse', 'origin/dev'], { cwd: downstream }).toString().trim();
    assert.notEqual(localSha, originSha, 'pre-condition: origin/dev must be ahead of local dev');

    const tip = await resolveIntegrationTip(downstream, 'dev');
    assert.equal(tip, originSha, 'most-advanced is origin/dev — must be selected');
    assert.notEqual(tip, localSha, 'stale local branch must NOT be selected');
  } finally {
    rmSync(upstream, { recursive: true, force: true });
    rmSync(downstream, { recursive: true, force: true });
  }
});

test('resolveIntegrationTip: merge-worktree HEAD wins when it is ahead of both origin and local (local-only case)', async () => {
  // Local-only repo: no remote. Simulate a landing by running a merge in a
  // detached merge worktree without pushing anywhere. The merge commit must be
  // returned as the most-advanced tip.
  const localRepo = mkdtempSync(join(tmpdir(), 'pc-tip-local-'));
  const mergeWtParent = mkdtempSync(join(tmpdir(), 'pc-tip-mwt-'));
  const mergeWtPath = join(mergeWtParent, '__dev-merge');
  const g = (...args: string[]) => execFileSync('git', args, { cwd: localRepo, stdio: 'ignore' });
  try {
    g('init', '-b', 'dev');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(localRepo, 'base.txt'), 'base\n');
    g('add', '.');
    g('commit', '-m', 'initial');

    // Create an agent branch with one commit.
    g('checkout', '-b', 'agent-phase0');
    writeFileSync(join(localRepo, 'phase0.txt'), 'phase0 work\n');
    g('add', '.');
    g('commit', '-m', 'phase0 work');
    g('checkout', 'dev');

    // Record dev tip before the landing (stale local).
    const devTipBefore = execFileSync('git', ['rev-parse', 'dev'], { cwd: localRepo })
      .toString()
      .trim();

    // Simulate what ensureMergeWorktree + mergeBranchIntoIntegration do:
    // create merge worktree in detached HEAD at dev, merge agent branch.
    execFileSync('git', ['worktree', 'add', '--detach', mergeWtPath, 'dev'], {
      cwd: localRepo,
      stdio: 'ignore',
    });
    execFileSync('git', ['merge', '--no-ff', 'agent-phase0'], {
      cwd: mergeWtPath,
      stdio: 'ignore',
    });

    const mergeWtHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: mergeWtPath })
      .toString()
      .trim();
    assert.notEqual(mergeWtHead, devTipBefore, 'pre-condition: merge commit advances __dev-merge');

    // resolveIntegrationTip must pick the merge-worktree HEAD — the ONLY place
    // the landed commit lives (no remote, local dev not advanced).
    const tip = await resolveIntegrationTip(localRepo, 'dev', mergeWtPath);
    assert.equal(tip, mergeWtHead, 'merge-worktree HEAD is the most-advanced tip (local-only case)');
    assert.notEqual(tip, devTipBefore, 'stale local dev branch must NOT be selected');
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', mergeWtPath], { cwd: localRepo, stdio: 'ignore' }); } catch { /* best-effort */ }
    rmSync(localRepo, { recursive: true, force: true });
    rmSync(mergeWtParent, { recursive: true, force: true });
  }
});

// ── updateRef (pc-pty-chat-417) ───────────────────────────────────────────────

test('updateRef: advances a local branch ref without checking it out', async () => {
  // Build a repo with two commits on dev, then roll dev back one commit, and
  // verify that updateRef moves it forward without any checkout.
  const repo5 = mkdtempSync(join(tmpdir(), 'pc-updateref-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo5, stdio: 'ignore' });
  const gOut = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo5 }).toString().trim();
  try {
    g('init', '-b', 'dev');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo5, 'a.txt'), 'a\n');
    g('add', '.');
    g('commit', '-m', 'first');
    writeFileSync(join(repo5, 'b.txt'), 'b\n');
    g('add', '.');
    g('commit', '-m', 'second');
    const secondSha = gOut('rev-parse', 'dev');

    // Roll dev back to the first commit.
    const firstSha = gOut('rev-parse', 'dev~1');
    g('update-ref', 'refs/heads/dev', firstSha); // direct git to set up the test
    assert.equal(gOut('rev-parse', 'dev'), firstSha, 'pre-condition: dev at first commit');

    // Now use our primitive to advance dev to secondSha.
    // Checkout a different branch so dev is NOT the current checkout.
    g('checkout', '-b', 'other');
    await updateRef(repo5, 'dev', secondSha);
    assert.equal(gOut('rev-parse', 'dev'), secondSha, 'updateRef advanced dev to the second commit');
  } finally {
    rmSync(repo5, { recursive: true, force: true });
  }
});

// ── resolveIntegrationTip — pc-pty-chat-443 Fix B tests ─────────────────────
// Test 1: diverged merge-wt HEAD is dropped; origin tip is returned instead.
// Test 2: genuinely-ahead merge-wt still wins (local-only case preserved).
// Test 5: absent mergeWtPath dir falls back to origin cleanly.

test('443-T1: resolveIntegrationTip drops a DIVERGED merge-wt candidate → returns origin tip', async () => {
  // Strategy: single repo with a remote. Start at C0. Create a LOCAL diverged
  // branch commit C_stale (the frozen __dev-merge simulation). Then advance
  // upstream to C1 so origin/dev=C1. C_stale and C1 both descend from C0 but
  // are NOT ancestors of each other — genuinely diverged. The merge worktree
  // is at C_stale. resolveIntegrationTip must return C1 (origin/dev), not
  // C_stale (the stale diverged merge-wt HEAD).
  const upstream = mkdtempSync(join(tmpdir(), 'pc-443t1-up-'));
  const repo = mkdtempSync(join(tmpdir(), 'pc-443t1-repo-'));
  const mergeWtParent = mkdtempSync(join(tmpdir(), 'pc-443t1-mwt-'));
  const mergeWtPath = join(mergeWtParent, '__dev-merge');
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  const gOut = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim();
  try {
    // 1. Set up bare upstream with an initial commit, clone to repo.
    const seedWork = mkdtempSync(join(tmpdir(), 'pc-443t1-seed-'));
    try {
      execFileSync('git', ['init', '--bare', '-b', 'dev'], { cwd: upstream, stdio: 'ignore' });
      const gs = (...args: string[]) => execFileSync('git', args, { cwd: seedWork, stdio: 'ignore' });
      gs('init', '-b', 'dev');
      gs('config', 'user.email', 't@t');
      gs('config', 'user.name', 't');
      gs('config', 'commit.gpgsign', 'false');
      writeFileSync(join(seedWork, 'base.txt'), 'base\n');
      gs('add', '.');
      gs('commit', '-m', 'C0 initial');
      gs('remote', 'add', 'origin', upstream);
      gs('push', 'origin', 'dev');
    } finally {
      rmSync(seedWork, { recursive: true, force: true });
    }
    execFileSync('git', ['clone', upstream, repo], { stdio: 'ignore' });
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');

    // 2. In repo: create C_stale (a diverged branch commit off C0).
    g('checkout', '-b', 'stale-branch');
    writeFileSync(join(repo, 'stale.txt'), 'stale content\n');
    g('add', '.');
    g('commit', '-m', 'C_stale diverged');
    const staleSha = gOut('rev-parse', 'HEAD');
    g('checkout', 'dev'); // back to dev (at C0)

    // 3. Advance upstream to C1 via a second clone (simulates a landing push).
    const landWork = mkdtempSync(join(tmpdir(), 'pc-443t1-land-'));
    let originTip: string;
    try {
      execFileSync('git', ['clone', upstream, landWork], { stdio: 'ignore' });
      const gl = (...args: string[]) => execFileSync('git', args, { cwd: landWork, stdio: 'ignore' });
      gl('config', 'user.email', 't@t');
      gl('config', 'user.name', 't');
      gl('config', 'commit.gpgsign', 'false');
      writeFileSync(join(landWork, 'landed.txt'), 'landed\n');
      gl('add', '.');
      gl('commit', '-m', 'C1 landing');
      gl('push', 'origin', 'dev');
      originTip = execFileSync('git', ['rev-parse', 'dev'], { cwd: landWork }).toString().trim();
    } finally {
      rmSync(landWork, { recursive: true, force: true });
    }
    // Fetch in repo so origin/dev = C1.
    g('fetch', 'origin');

    // 4. Create the merge worktree at the stale diverged SHA (C_stale is in
    //    the local object store since it was committed in step 2).
    execFileSync('git', ['worktree', 'add', '--detach', mergeWtPath, staleSha], {
      cwd: repo,
      stdio: 'ignore',
    });

    // Pre-conditions.
    const resolvedOriginSha = gOut('rev-parse', 'origin/dev');
    assert.equal(resolvedOriginSha, originTip, 'pre-condition: origin/dev = C1');
    assert.notEqual(resolvedOriginSha, staleSha, 'pre-condition: C1 != C_stale (genuinely diverged)');

    // 5. THE FIX B assertion.
    const tip = await resolveIntegrationTip(repo, 'dev', mergeWtPath);
    assert.equal(tip, originTip, '443-T1: diverged merge-wt HEAD must be dropped; origin/dev (C1) must win');
    assert.notEqual(tip, staleSha, '443-T1: stale diverged C_stale SHA must NOT be returned');
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', mergeWtPath], { cwd: repo, stdio: 'ignore' }); } catch { /* best-effort */ }
    rmSync(repo, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
    rmSync(mergeWtParent, { recursive: true, force: true });
  }
});

test('443-T2: resolveIntegrationTip keeps merge-wt HEAD when it is GENUINELY ahead (local-only case preserved)', async () => {
  // Identical setup to the existing local-only test above: no remote, merge
  // worktree has the freshest commit. Fix B must NOT affect this case.
  // (Regression guard: this is the legitimate path that must still win.)
  const localRepo = mkdtempSync(join(tmpdir(), 'pc-443t2-'));
  const mergeWtParent = mkdtempSync(join(tmpdir(), 'pc-443t2-mwt-'));
  const mergeWtPath = join(mergeWtParent, '__dev-merge');
  const g = (...args: string[]) => execFileSync('git', args, { cwd: localRepo, stdio: 'ignore' });
  try {
    g('init', '-b', 'dev');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(localRepo, 'base.txt'), 'base\n');
    g('add', '.');
    g('commit', '-m', 'initial');

    g('checkout', '-b', 'agent-t2');
    writeFileSync(join(localRepo, 't2.txt'), 't2 work\n');
    g('add', '.');
    g('commit', '-m', 't2 work');
    g('checkout', 'dev');

    const devTipBefore = execFileSync('git', ['rev-parse', 'dev'], { cwd: localRepo }).toString().trim();

    // Simulate a local landing: merge into __dev-merge worktree (no remote push).
    execFileSync('git', ['worktree', 'add', '--detach', mergeWtPath, 'dev'], {
      cwd: localRepo,
      stdio: 'ignore',
    });
    execFileSync('git', ['merge', '--no-ff', 'agent-t2'], { cwd: mergeWtPath, stdio: 'ignore' });
    const mergeWtHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: mergeWtPath }).toString().trim();

    assert.notEqual(mergeWtHead, devTipBefore, 'pre-condition: merge commit advanced ahead of dev');

    // Fix B must preserve this: merge-wt HEAD is genuinely ahead → must still win.
    const tip = await resolveIntegrationTip(localRepo, 'dev', mergeWtPath);
    assert.equal(tip, mergeWtHead, '443-T2: genuinely-ahead merge-wt HEAD must still win (local-only case)');
    assert.notEqual(tip, devTipBefore, '443-T2: stale local dev must NOT be selected');
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', mergeWtPath], { cwd: localRepo, stdio: 'ignore' }); } catch { /* best-effort */ }
    rmSync(localRepo, { recursive: true, force: true });
    rmSync(mergeWtParent, { recursive: true, force: true });
  }
});

test('443-T5: resolveIntegrationTip with absent mergeWtPath falls back to origin cleanly', async () => {
  // The absent-dir case: pass a mergeWtPath that does not exist on disk.
  // Should not throw; origin/dev must be returned as the tip.
  const upstream = mkdtempSync(join(tmpdir(), 'pc-443t5-up-'));
  const repo = mkdtempSync(join(tmpdir(), 'pc-443t5-repo-'));
  const absentPath = join(repo, '__dev-merge-absent');
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  try {
    execFileSync('git', ['init', '--bare', '-b', 'dev'], { cwd: upstream, stdio: 'ignore' });
    const seed = mkdtempSync(join(tmpdir(), 'pc-443t5-seed-'));
    try {
      const gs = (...args: string[]) => execFileSync('git', args, { cwd: seed, stdio: 'ignore' });
      gs('init', '-b', 'dev');
      gs('config', 'user.email', 't@t');
      gs('config', 'user.name', 't');
      gs('config', 'commit.gpgsign', 'false');
      writeFileSync(join(seed, 'base.txt'), 'base\n');
      gs('add', '.');
      gs('commit', '-m', 'initial');
      gs('remote', 'add', 'origin', upstream);
      gs('push', 'origin', 'dev');
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }
    execFileSync('git', ['clone', upstream, repo], { stdio: 'ignore' });
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');

    const originTip = execFileSync('git', ['rev-parse', 'origin/dev'], { cwd: repo }).toString().trim();

    // The merge-wt dir does not exist — must not throw, must return origin tip.
    const tip = await resolveIntegrationTip(repo, 'dev', absentPath);
    assert.equal(tip, originTip, '443-T5: absent mergeWtPath must fall back to origin/dev cleanly');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
  }
});
