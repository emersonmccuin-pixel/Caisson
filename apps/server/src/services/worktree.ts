// Worktree service. Per-project: bound to one repo's workspace cwd and one
// trunk-side base dir under the data dir (`<data_dir>/worktrees/<slug>/`).
// Wraps @pc/runtime's git primitives with an in-memory cache (for UI polls)
// and DB-side tracking (for work-item / run bindings).
//
// Multi-tenancy (P6): path policy lives here. `<workspace>/../worktrees/` is
// dead — every worktree lives under the data dir, namespaced by project slug,
// so multiple projects don't fight for the same `worktrees/` dir and so
// nothing leaks into the user's actual repo.
//
// Provisioning: every worktree is fully dep-installed BEFORE being returned
// to any caller. This guarantees typecheck / build commands inside the
// worktree have a complete node_modules and never false-fail with "Cannot
// find module" errors (pc-pty-chat-305). The install command is detected
// from a root lockfile, or from nested package.json+lockfile pairs when the
// repo has no root lockfile; truly polyglot / non-Node repos skip the install
// instead of failing the run on a bootstrap step they never declared.

import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';

import {
  attachWorktree as _attachWorktree,
  branchMergedInto as _branchMergedInto,
  createWorktree as _createWorktree,
  deleteBranch as _deleteBranch,
  destroyWorktree as _destroyWorktree,
  ensureMergeWorktree as _ensureMergeWorktree,
  fastForwardWorktree as _fastForwardWorktree,
  gitMergeState as _gitMergeState,
  getWorktreeStatus as _getWorktreeStatus,
  listBranchesByPrefix as _listBranchesByPrefix,
  listWorktrees as _listWorktrees,
  mergeBranchIntoHead as _mergeBranchIntoHead,
  pruneWorktrees as _pruneWorktrees,
  pushBranch as _pushBranch,
  resolveIntegrationTip as _resolveIntegrationTip,
  resolveLocalBranchHead as _resolveLocalBranchHead,
  updateRef as _updateRef,
  type GitMergeState,
  type WorktreeEntry,
} from '@pc/runtime';
import { markWorktreeDestroyed, upsertWorktree } from '@pc/db';

export interface WorktreeRegistry {
  updatedAt: string;
  worktrees: WorktreeEntry[];
}

export type ProvisionedWorktreeEntry = WorktreeEntry & {
  /** Canonical branch the worktree forked from. */
  baseBranch?: string;
  /** Commit SHA of `baseBranch` at dispatch/provision time. */
  baseSha?: string;
};

/**
 * Dep-injection seam for WorktreeService. All fields optional; defaults are
 * the real implementations. Pass overrides in tests to avoid spawning actual
 * git or pnpm processes.
 */
export interface WorktreeServiceDeps {
  /**
   * Run dependency install in a freshly created/attached worktree directory.
   * Default: lockfile-detected install (`pnpm install --frozen-lockfile` /
   * `yarn install --frozen-lockfile` / `npm ci`; shell: true so the .cmd
   * shims resolve on Windows). No root lockfile → no-op.
   */
  installRunner?: (cwd: string) => Promise<void>;
  createWorktree?: (
    workspaceDir: string,
    wtPath: string,
    branchName: string,
    startPoint?: string,
  ) => Promise<WorktreeEntry>;
  attachWorktree?: (
    workspaceDir: string,
    wtPath: string,
    branchName: string,
  ) => Promise<WorktreeEntry>;
  listWorktrees?: (workspaceDir: string) => Promise<WorktreeEntry[]>;
  pruneWorktrees?: (workspaceDir: string) => Promise<void>;
  destroyWorktree?: (
    workspaceDir: string,
    wtPath: string,
    opts?: { force?: boolean },
  ) => Promise<void>;
  /** Override for `mergeBranchIntoHead` (avoids real git in tests). */
  mergeBranchIntoHead?: (workspaceDir: string, branch: string) => Promise<void>;
  /** Override for `pushBranch` (avoids real git in tests). */
  pushBranch?: (workspaceDir: string, ref: string) => Promise<void>;
  /** Override for `gitMergeState` (avoids real git in tests). */
  gitMergeState?: (
    workspaceDir: string,
    branch: string,
    integrationBranch: string,
  ) => Promise<GitMergeState>;
  /**
   * Override for `ensureMergeWorktree` — skips real git worktree creation in
   * tests. The real impl creates/reuses a detached worktree at the integration
   * tip under `baseDir` (with the lineage guard).
   */
  ensureMergeWorktree?: (
    workspaceDir: string,
    wtPath: string,
    integrationBranch: string,
  ) => Promise<void>;
  /**
   * Override for `getWorktreeStatus` — returns synthetic branch/cleanliness in
   * tests without inspecting a real git worktree.
   */
  getWorktreeStatus?: (wtPath: string) => Promise<{ branch: string | null; clean: boolean }>;
  /** Override for `branchMergedInto` (avoids real git in tests). */
  branchMergedInto?: (
    workspaceDir: string,
    branch: string,
    integrationBranch: string,
  ) => Promise<boolean>;
  /** Override for `deleteBranch` (avoids real git in tests). */
  deleteBranch?: (workspaceDir: string, branch: string) => Promise<void>;
  /** Override for `listBranchesByPrefix` (avoids real git in tests). */
  listBranchesByPrefix?: (workspaceDir: string, prefixes: string[]) => Promise<string[]>;
  /** Override for baseDir directory listing (sweep husk scan). */
  listBaseDirNames?: (baseDir: string) => Promise<string[]>;
  /** Override for recursive directory delete (sweep husk removal). */
  removeDirectory?: (path: string) => Promise<void>;
  /**
   * Override for `resolveIntegrationTip` — returns the most-advanced landed
   * commit SHA (merge-wt HEAD > origin/<integration> > local) without real git.
   */
  resolveIntegrationTip?: (
    workspaceDir: string,
    integrationBranch: string,
    mergeWtPath?: string,
  ) => Promise<string | null>;
  /** Resolve the current LOCAL canonical branch HEAD for dispatch provenance. */
  resolveLocalBranchHead?: (
    workspaceDir: string,
    integrationBranch: string,
  ) => Promise<string | null>;
  /**
   * Override for `updateRef` — advances a local branch pointer without real
   * git (used in `tryAdvanceLocalIntegration` tests).
   */
  updateRef?: (workspaceDir: string, branch: string, sha: string) => Promise<void>;
  /** Override for checked-out branch fast-forward (tests avoid real git). */
  fastForwardWorktree?: (workspaceDir: string, sha: string) => Promise<void>;
}

/** Names the engine reaps automatically: per-run isolation worktrees, per-
 *  landing merge worktrees (torn down after each successful push; husks from
 *  crash-aborted merges are collected on the next sweep), and the legacy
 *  shared merge worktree name (`__dev-merge`) whose creator was removed in
 *  pc-pty-chat-443 Fix C — exact match only, never broadened to `__dev-*`. */
const REAPABLE_NAME_RE = /^(agent|wf)-[A-Za-z0-9._-]+$|^__merge-[A-Za-z0-9._-]+$|^__dev-merge$/;

export interface WorktreeSweepResult {
  /** Registered worktrees removed (branch merged, not in use). */
  removedWorktrees: string[];
  /** Local branches deleted (merged, no worktree, not in use). */
  deletedBranches: string[];
  /** Unregistered leftover directories deleted from baseDir. */
  removedHusks: string[];
  /** Deliberate keeps, each with its reason (positive receipt). */
  kept: { name: string; reason: 'in-use' | 'unmerged' }[];
  /** Removal attempts that FAILED (locked files etc.) — distinct from kept:
   *  these should have been removed and will be retried next sweep. */
  failed: { name: string; op: 'worktree-remove' | 'branch-delete' | 'husk-remove'; message: string }[];
}

/**
 * Lockfile → install command, in detection order. Frozen/ci variants only:
 * provisioning must never rewrite a lockfile inside a run worktree.
 */
const LOCKFILE_INSTALL_COMMANDS: ReadonlyArray<{ lockfile: string; command: string }> = [
  { lockfile: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile' },
  { lockfile: 'yarn.lock', command: 'yarn install --frozen-lockfile' },
  { lockfile: 'package-lock.json', command: 'npm ci' },
];

export interface InstallStep {
  cwd: string;
  command: string;
}

const INSTALL_SCAN_SKIP = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'coverage',
  'out',
]);

/**
 * Detect the dependency-install command for a worktree from the lockfile at
 * its root. Returns null when no known lockfile exists — polyglot / non-Node
 * repos have nothing the engine can frozen-install at the root. Nested Node
 * projects are handled by `detectInstallSteps`.
 */
export function detectInstallCommand(cwd: string): string | null {
  for (const { lockfile, command } of LOCKFILE_INSTALL_COMMANDS) {
    if (existsSync(resolve(cwd, lockfile))) return command;
  }
  return null;
}

/**
 * Detect every package-manager install that provisioning must run. Root
 * lockfile wins (normal monorepo case). If the repo has no root lockfile, scan
 * a shallow tree for nested package.json+lockfile pairs so subdir apps are not
 * handed to agents without dependencies.
 */
export function detectInstallSteps(cwd: string): InstallStep[] {
  const rootCommand = detectInstallCommand(cwd);
  if (rootCommand) return [{ cwd, command: rootCommand }];

  const out: InstallStep[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return;
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return;
    }
    for (const name of names) {
      if (INSTALL_SCAN_SKIP.has(name)) continue;
      const child = resolve(dir, name);
      const command = existsSync(resolve(child, 'package.json'))
        ? detectInstallCommand(child)
        : null;
      if (command) {
        out.push({ cwd: child, command });
        continue;
      }
      visit(child, depth + 1);
    }
  };
  visit(cwd, 1);
  return out;
}

/**
 * Default install runner: lockfile-detected install inside the worktree.
 * Uses shell: true so the pnpm.cmd/yarn.cmd/npm.cmd shims resolve on Windows
 * (mirrors the pattern in scripts/dev-staging.mjs). No root lockfile → no-op
 * — a missing optional bootstrap must not kill the run (the AHEAD bug:
 * hardcoded `pnpm install --frozen-lockfile` failed every worktree on a
 * Yarn-in-subdir + Bundler repo before node 1 ever ran).
 */
export function defaultInstallRunner(cwd: string): Promise<void> {
  const steps = detectInstallSteps(cwd);
  if (steps.length === 0) return Promise.resolve();
  return steps.reduce(
    (chain, step) => chain.then(() => runInstallStep(step)),
    Promise.resolve(),
  );
}

function runInstallStep(step: InstallStep): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(step.command, {
      shell: true,
      cwd: step.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', rej);
    child.on('close', (code) => {
      if (code === 0) {
        res();
      } else {
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        rej(
          new Error(
            `${step.command} failed (exit ${code}) in ${step.cwd}` +
              (stderr ? `:\n${stderr}` : ''),
          ),
        );
      }
    });
  });
}

export class WorktreeService {
  private cache: WorktreeRegistry = { updatedAt: new Date(0).toISOString(), worktrees: [] };
  private readonly deps: WorktreeServiceDeps;

  /**
   * @param workspaceDir Absolute path to the project's git repo (cwd for git ops).
   * @param baseDir Absolute path under which this project's worktrees live —
   *   `<data_dir>/worktrees/<slug>/` per the multi-tenancy design §4. Each
   *   worktree directory becomes `<baseDir>/<name>/`.
   * @param getIntegrationBranch Resolver for the project's integration branch
   *   (the merge target + landed-predicate base). REQUIRED — there is no
   *   hardcoded fallback; the resolver throws loudly when unresolvable.
   * @param deps Optional overrides for git primitives and the install runner
   *   (for testing without real git or pnpm processes).
   */
  constructor(
    private readonly workspaceDir: string,
    private readonly baseDir: string,
    private readonly getIntegrationBranch: () => Promise<string>,
    deps: WorktreeServiceDeps = {},
  ) {
    this.deps = deps;
  }

  /** The project's resolved integration branch (for receipts/error strings). */
  integrationBranch(): Promise<string> {
    return this.getIntegrationBranch();
  }

  async list(): Promise<WorktreeEntry[]> {
    const listFn = this.deps.listWorktrees ?? _listWorktrees;
    const entries = await listFn(this.workspaceDir);
    this.cache = { updatedAt: new Date().toISOString(), worktrees: entries };
    // Reconcile DB rows with git's view. Main repo (entries[0]) is the
    // workspace itself; don't track it. Filter to entries under this project's
    // baseDir so a stray repo-local worktree doesn't end up in our table.
    const baseNorm = normalize(this.baseDir);
    for (const entry of entries.slice(1)) {
      if (!normalize(entry.path).startsWith(baseNorm)) continue;
      const name = nameFromPath(entry.path);
      if (name) upsertWorktree({ name, path: entry.path });
    }
    return entries;
  }

  /** D1c (pc-pty-chat-440): the path a worktree named `name` will occupy.
   *  Computed before the git branch is created so the route can pre-insert
   *  the DB run row, closing the sweep gap between branch creation and insert. */
  plannedWorktreePath(name: string): string {
    return resolve(this.baseDir, name);
  }

  async create(name: string): Promise<ProvisionedWorktreeEntry> {
    const wtPath = resolve(this.baseDir, name);

    const integration = await this.getIntegrationBranch();
    const statusFn = this.deps.getWorktreeStatus ?? _getWorktreeStatus;
    const mainStatus = await statusFn(this.workspaceDir);
    if (mainStatus.branch !== integration) {
      throw new Error(
        `MAINLINE GUARD: repo dispatch requires the main checkout to be on "${integration}" ` +
          `before creating an agent worktree; current checkout is ` +
          `${mainStatus.branch ? `"${mainStatus.branch}"` : 'detached HEAD'}`,
      );
    }
    if (!mainStatus.clean) {
      throw new Error(
        `MAINLINE GUARD: repo dispatch requires a clean "${integration}" checkout before ` +
          'creating an agent worktree',
      );
    }

    // D1a (pc-pty-chat-440): use resolveIntegrationTip (origin/<integration> >
    // local ref) so new branches always fork from the most-advanced landed
    // state — never from a stale local pointer that lags origin. The shared
    // merge-worktree path is deliberately NOT passed: it was a write-once
    // orphan (pc-pty-chat-443) whose frozen HEAD caused deterministic stale
    // forks. origin/<integration> is the authoritative pushed tip.
    const tipFn = this.deps.resolveIntegrationTip ?? _resolveIntegrationTip;
    const startPoint = await tipFn(this.workspaceDir, integration);
    if (!startPoint) {
      throw new Error(
        `MAINLINE GUARD: integration branch "${integration}" has no resolvable tip — ` +
          'ensure the integration branch has at least one commit before dispatching repo work',
      );
    }

    const createFn = this.deps.createWorktree ?? _createWorktree;
    const entry = await createFn(this.workspaceDir, wtPath, name, startPoint);
    // Provision BEFORE returning — callers must never see a half-built worktree.
    await this.provision(entry.path);
    upsertWorktree({ name, path: entry.path });
    await this.refresh();
    return { ...entry, baseBranch: integration, baseSha: startPoint };
  }

  async destroy(target: string, force = false): Promise<void> {
    const wtPath = isAbsolutePath(target) ? target : resolve(this.baseDir, target);
    const destroyFn = this.deps.destroyWorktree ?? _destroyWorktree;
    await destroyFn(this.workspaceDir, wtPath, { force });
    const name = nameFromPath(wtPath);
    if (name) markWorktreeDestroyed(name);
    await this.refresh();
  }

  /**
   * Tear down a run worktree after its branch has verifiably landed on the
   * integration branch: remove the worktree (force — node_modules is
   * untracked) and delete the local branch. Refuses loudly if the branch is
   * NOT merged — never deletes unlanded work. Called by the workflow merge
   * node after both positive merge receipts; the sweep is the backstop for
   * anything missed.
   */
  async teardownAfterMerge(branch: string): Promise<void> {
    const integration = await this.getIntegrationBranch();
    const mergedFn = this.deps.branchMergedInto ?? _branchMergedInto;
    if (!(await mergedFn(this.workspaceDir, branch, integration))) {
      throw new Error(
        `TEARDOWN GUARD: branch "${branch}" is not merged into "${integration}" — refusing to tear down`,
      );
    }
    // Worktree dir name === branch name (ensureWorktree contract). The dir may
    // already be gone (manual cleanup, partial removal) — branch delete still runs.
    try {
      await this.destroy(branch, true);
    } catch (err) {
      if (!/is not a working tree|No such file|not a valid path/i.test((err as Error).message)) {
        throw err;
      }
      const pruneFn = this.deps.pruneWorktrees ?? _pruneWorktrees;
      await pruneFn(this.workspaceDir);
    }
    const deleteFn = this.deps.deleteBranch ?? _deleteBranch;
    await deleteFn(this.workspaceDir, branch);
  }

  /**
   * pc-pty-chat-415 (R12/R14) — tear down an ABANDONED run worktree: remove
   * the directory (force — node_modules is untracked) but PRESERVE the branch.
   * The branch is the durable record of unlanded work; the abandon door
   * records its tip on the contract BEFORE calling here. No merged guard —
   * abandoning unmerged work is the point; the caller is an explicit
   * human/orchestrator decision, never an automatic janitor.
   */
  async teardownAfterAbandon(branch: string): Promise<void> {
    try {
      await this.destroy(branch, true);
    } catch (err) {
      if (!/is not a working tree|No such file|not a valid path/i.test((err as Error).message)) {
        throw err;
      }
      const pruneFn = this.deps.pruneWorktrees ?? _pruneWorktrees;
      await pruneFn(this.workspaceDir);
    }
  }

  /**
   * pc-pty-chat-415 (R14) — read-only STRANDED report: unmerged run worktrees
   * and branches that no live run references. These are never auto-deleted
   * (the sweep keeps unmerged work, always); they are surfaced so a human or
   * the orchestrator decides: retry, land, or abandon. The route layer filters
   * out branches already recorded as abandoned on a contract.
   */
  async listStranded(
    inUsePaths: Iterable<string>,
  ): Promise<Array<{ name: string; branch: string; path: string | null }>> {
    const integration = await this.getIntegrationBranch();
    const inUse = new Set<string>();
    const inUseNames = new Set<string>();
    for (const p of inUsePaths) {
      inUse.add(normalize(p));
      const n = nameFromPath(p);
      if (n) inUseNames.add(n);
    }
    const mergedFn = this.deps.branchMergedInto ?? _branchMergedInto;
    const baseNorm = normalize(this.baseDir);
    const out: Array<{ name: string; branch: string; path: string | null }> = [];
    const seen = new Set<string>();

    const entries = (await this.list()).slice(1).filter((e) => {
      const name = nameFromPath(e.path);
      return normalize(e.path).startsWith(baseNorm) && name !== null && REAPABLE_NAME_RE.test(name);
    });
    for (const entry of entries) {
      const name = nameFromPath(entry.path)!;
      if (inUse.has(normalize(entry.path)) || inUseNames.has(name)) continue;
      const branch = entry.branch ?? name;
      if (await mergedFn(this.workspaceDir, branch, integration)) continue;
      out.push({ name, branch, path: entry.path });
      seen.add(branch);
    }

    // Unmerged branches whose worktree dir is already gone (manual deletes,
    // abandon-with-dir-reclaimed, teardown crash windows).
    const listBranchesFn = this.deps.listBranchesByPrefix ?? _listBranchesByPrefix;
    for (const branch of await listBranchesFn(this.workspaceDir, ['agent-', 'wf-'])) {
      if (seen.has(branch) || inUseNames.has(branch)) continue;
      if (await mergedFn(this.workspaceDir, branch, integration)) continue;
      out.push({ name: branch, branch, path: null });
    }
    return out;
  }

  /**
   * Backstop sweep (boot + periodic). Reaps, under this project's baseDir only:
   *  1. registered `agent-*`/`wf-*` worktrees whose branch is merged into the
   *     integration branch and which no live run references,
   *  2. merged local `agent-*`/`wf-*` branches with no worktree left,
   *  3. unregistered leftover directories (husks from interrupted removals —
   *     Windows file locks abort `git worktree remove` partway).
   * Never touches unmerged branches or in-use paths.
   *
   * Positive receipt: every keep carries a reason; every failure (locked dir,
   * git error) lands in `failed` with the real message — nothing is swallowed.
   */
  async sweepStale(inUsePaths: Iterable<string>): Promise<WorktreeSweepResult> {
    const integration = await this.getIntegrationBranch();
    const result: WorktreeSweepResult = {
      removedWorktrees: [],
      deletedBranches: [],
      removedHusks: [],
      kept: [],
      failed: [],
    };
    const inUse = new Set<string>();
    const inUseNames = new Set<string>();
    for (const p of inUsePaths) {
      inUse.add(normalize(p));
      const n = nameFromPath(p);
      if (n) inUseNames.add(n);
    }

    const pruneFn = this.deps.pruneWorktrees ?? _pruneWorktrees;
    await pruneFn(this.workspaceDir);

    const baseNorm = normalize(this.baseDir);
    const entries = (await this.list()).slice(1).filter((e) => {
      const name = nameFromPath(e.path);
      return (
        normalize(e.path).startsWith(baseNorm) && name !== null && REAPABLE_NAME_RE.test(name)
      );
    });

    const mergedFn = this.deps.branchMergedInto ?? _branchMergedInto;
    const survivors = new Set<string>();
    for (const entry of entries) {
      const name = nameFromPath(entry.path)!;
      const branch = entry.branch ?? name;
      if (inUse.has(normalize(entry.path))) {
        result.kept.push({ name, reason: 'in-use' });
        survivors.add(name);
        continue;
      }
      if (!(await mergedFn(this.workspaceDir, branch, integration))) {
        result.kept.push({ name, reason: 'unmerged' });
        survivors.add(name);
        continue;
      }
      try {
        await this.destroy(entry.path, true);
        result.removedWorktrees.push(name);
      } catch (err) {
        // Locked dir etc. — keep the dir; the next sweep retries. The failure
        // is RECORDED, not swallowed (the 4-silent-keeps incident, 2026-06-11).
        result.failed.push({ name, op: 'worktree-remove', message: (err as Error).message });
        survivors.add(name);
      }
    }

    // Merged branches with no worktree left (teardown crash window, manual
    // dir deletes). In-use names are skipped so a mid-re-drive merge node can
    // still resolve its branch ref.
    const listBranchesFn = this.deps.listBranchesByPrefix ?? _listBranchesByPrefix;
    const branches = await listBranchesFn(this.workspaceDir, ['agent-', 'wf-']);
    const deleteFn = this.deps.deleteBranch ?? _deleteBranch;
    for (const branch of branches) {
      if (survivors.has(branch) || inUseNames.has(branch)) continue;
      if (!(await mergedFn(this.workspaceDir, branch, integration))) continue;
      try {
        await deleteFn(this.workspaceDir, branch);
        result.deletedBranches.push(branch);
      } catch (err) {
        result.failed.push({ name: branch, op: 'branch-delete', message: (err as Error).message });
      }
    }

    // Husks: dirs in baseDir that look like run worktrees but aren't
    // registered with git (interrupted removals). Registered survivors and
    // in-use paths are excluded above by construction.
    const listNamesFn =
      this.deps.listBaseDirNames ??
      (async (dir: string) => {
        try {
          return (await readdir(dir, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        } catch {
          return []; // baseDir absent — nothing to sweep
        }
      });
    const removeDirFn =
      this.deps.removeDirectory ?? ((p: string) => rm(p, { recursive: true, force: true }));
    for (const name of await listNamesFn(this.baseDir)) {
      if (!REAPABLE_NAME_RE.test(name) || survivors.has(name) || inUseNames.has(name)) continue;
      if (result.removedWorktrees.includes(name)) continue; // already gone via destroy()
      try {
        await removeDirFn(resolve(this.baseDir, name));
        result.removedHusks.push(name);
      } catch (err) {
        result.failed.push({ name, op: 'husk-remove', message: (err as Error).message });
      }
    }

    return result;
  }

  /**
   * Idempotent "ensure a worktree named `name` exists" under this project's
   * baseDir. Orphan-recovery: prune stale registrations, return the existing
   * entry if the dir is already attached, else try a fresh create, falling
   * back to `git worktree add` (no `-b`) if the branch already exists from a
   * previous failed dispatch.
   *
   * Both the create and attach paths call provision() before returning.
   */
  async ensureWorktree(name: string): Promise<ProvisionedWorktreeEntry> {
    const pruneFn = this.deps.pruneWorktrees ?? _pruneWorktrees;
    const listFn = this.deps.listWorktrees ?? _listWorktrees;
    await pruneFn(this.workspaceDir);
    const wtPath = resolve(this.baseDir, name);
    const integration = await this.getIntegrationBranch();
    // D1a: match-path baseSha — same tip resolution as create() so the returned
    // receipt is consistent whether the worktree matched or was freshly created.
    // No mergeWtPath: see create() comment (pc-pty-chat-443 fix A).
    const tipFn = this.deps.resolveIntegrationTip ?? _resolveIntegrationTip;
    const baseSha = await tipFn(this.workspaceDir, integration);
    const existing = await listFn(this.workspaceDir);
    const match = existing.find((e) => normalize(e.path) === normalize(wtPath));
    if (match) {
      await this.provision(match.path);
      this.cache = { updatedAt: new Date().toISOString(), worktrees: existing };
      upsertWorktree({ name, path: match.path });
      return { ...match, baseBranch: integration, ...(baseSha ? { baseSha } : {}) };
    }
    try {
      return await this.create(name);
    } catch (err) {
      const msg = (err as Error).message;
      if (!/already exists|already used by worktree|already checked out/i.test(msg)) {
        throw err;
      }
      // Orphan-recovery: branch exists but worktree dir was gone.
      const attachFn = this.deps.attachWorktree ?? _attachWorktree;
      const entry = await attachFn(this.workspaceDir, wtPath, name);
      // Provision BEFORE returning — same guarantee as the create path.
      await this.provision(entry.path);
      upsertWorktree({ name, path: entry.path });
      await this.refresh();
      return entry;
    }
  }

  /** Cached read for polling endpoints. Empty until the first list() / mutate(). */
  readCached(): WorktreeRegistry {
    return this.cache;
  }

  // ── Merge / push wrappers (pc-pty-chat-270) ──────────────────────────────
  //
  // ALL merge operations run inside a dedicated, engine-controlled per-landing
  // merge worktree (`<baseDir>/__merge-<branch>/`) — NEVER in `workspaceDir`
  // (the user's main checkout). This eliminates the bug where `git merge`
  // would run in the user's repo regardless of which branch they had checked
  // out or whether their tree was dirty. D1d gives each landing its own
  // worktree so concurrent landings never share MERGE_HEAD state.
  //
  // The merge worktree is detached at the integration branch's tip — no dep
  // install. It is created lazily per landing (the lineage guard in
  // ensureMergeWorktree recreates it when stale).
  //
  // `mergeBranchIntoIntegration` additionally asserts that the worktree is on
  // the integration branch (or detached) and clean before touching anything
  // (belt-and-suspenders guard). A violation returns loudly — never silently
  // merges into the wrong place.
  //
  // NOTE: the shared `__dev-merge` worktree (pre-pc-pty-chat-443) has been
  // removed. Only the per-landing `__merge-<branch>` path remains.

  /** D1d (pc-pty-chat-440): path for the per-landing merge worktree. Each
   *  landing creates its own `__merge-<branch>` so concurrent landings never
   *  share merge state (MERGE_HEAD is worktree-local). */
  landingMergeWorktreePath(branch: string): string {
    return resolve(this.baseDir, `__merge-${branch}`);
  }

  /** Ensure a per-landing merge worktree exists at `__merge-<branch>`. */
  private async ensureLandingMergeWorktreeReady(
    branch: string,
  ): Promise<{ wtPath: string; integration: string }> {
    const integration = await this.getIntegrationBranch();
    const wtPath = this.landingMergeWorktreePath(branch);
    const fn = this.deps.ensureMergeWorktree ?? _ensureMergeWorktree;
    await fn(this.workspaceDir, wtPath, integration);
    return { wtPath, integration };
  }

  /**
   * Merge `branch` into the integration branch (`--no-ff`) in the
   * engine-controlled merge worktree (NOT in the user's main working tree).
   * D1d: each landing uses its own `__merge-<branch>` worktree so concurrent
   * landings never stomp each other's MERGE_HEAD. The worktree is in detached
   * HEAD at the integration tip; the merge advances HEAD. Asserts the worktree
   * is clean before merging; throws loudly on any violation. Callers should
   * call `mergeState` first for idempotency.
   */
  async mergeBranchIntoIntegration(branch: string): Promise<void> {
    const { wtPath, integration } = await this.ensureLandingMergeWorktreeReady(branch);

    // Belt-and-suspenders: assert the merge worktree is in a valid state
    // before any destructive git command. Valid states: detached HEAD
    // (branch === null, our normal creation mode via --detach) or tracking
    // the integration branch directly. Any OTHER branch means something is
    // badly wrong — refuse loudly.
    const statusFn = this.deps.getWorktreeStatus ?? _getWorktreeStatus;
    const { branch: currentBranch, clean } = await statusFn(wtPath);
    if (currentBranch !== null && currentBranch !== integration) {
      throw new Error(
        `MERGE GUARD: merge worktree is on branch "${currentBranch}", expected detached HEAD or "${integration}" — refusing to merge`,
      );
    }
    if (!clean) {
      throw new Error(
        `MERGE GUARD: merge worktree has uncommitted changes — refusing to merge into a dirty tree`,
      );
    }

    const fn = this.deps.mergeBranchIntoHead ?? _mergeBranchIntoHead;
    // Pass wtPath as the cwd — the user's workspaceDir is never touched.
    await fn(wtPath, branch);
  }

  /**
   * Push the integration branch to its origin counterpart. D1d: pushes from
   * the per-landing merge worktree (`__merge-<branch>`). When the worktree is
   * in detached HEAD (the normal case after --detach), pushes
   * `HEAD:<integration>` so the merge commit reaches origin. Call after a
   * verified merge. `branch` is the run branch being landed — always required
   * (landing-service.ts always provides it; the old no-branch shared-worktree
   * path has been removed, pc-pty-chat-443 Fix C).
   */
  async pushIntegration(branch: string): Promise<void> {
    const { wtPath, integration } = await this.ensureLandingMergeWorktreeReady(branch);
    const statusFn = this.deps.getWorktreeStatus ?? _getWorktreeStatus;
    const { branch: wtBranch } = await statusFn(wtPath);
    // Detached HEAD (standard merge worktree): push HEAD (the merge commit)
    // to the origin integration branch. Branch-tracking worktree: push the
    // branch normally.
    const refspec = wtBranch === null ? `HEAD:${integration}` : integration;
    const fn = this.deps.pushBranch ?? _pushBranch;
    await fn(wtPath, refspec);
  }

  /** D1d: tear down the per-landing merge worktree after a successful push.
   *  Best-effort — the sweep collects husks from crash-aborted merges on the
   *  next cycle. */
  async teardownLandingMergeWorktree(branch: string): Promise<void> {
    const wtPath = this.landingMergeWorktreePath(branch);
    try {
      const destroyFn = this.deps.destroyWorktree ?? _destroyWorktree;
      await destroyFn(this.workspaceDir, wtPath, { force: true });
    } catch (err) {
      if (!/is not a working tree|No such file|not a valid path/i.test((err as Error).message)) {
        throw err;
      }
      const pruneFn = this.deps.pruneWorktrees ?? _pruneWorktrees;
      await pruneFn(this.workspaceDir);
    }
  }

  /**
   * Read-only inspection of merge / push state for `branch` relative to the
   * integration branch, run from the per-landing merge worktree. All checks
   * are non-destructive. MERGE_HEAD is read from the merge worktree (each
   * worktree has its own MERGE_HEAD), so it correctly reflects
   * conflicts that occurred there.
   */
  async mergeState(branch: string): Promise<GitMergeState> {
    // D1d: per-landing merge worktree so each landing's MERGE_HEAD is isolated.
    const { wtPath, integration } = await this.ensureLandingMergeWorktreeReady(branch);
    const fn = this.deps.gitMergeState ?? _gitMergeState;
    return fn(wtPath, branch, integration);
  }

  /**
   * Belt-and-suspenders after a successful landing: advance the LOCAL
   * integration branch ref to the merge-worktree HEAD so standard git tools
   * see the merged work, and so the local ref is available as a fallback
   * start-point for new run worktrees.
   *
   * When the main worktree is on the integration branch, fast-forward it so
   * the working tree/index stay coherent. When it is on some other branch,
   * move only the local integration ref with `git update-ref`.
   *
   * Best-effort: never throws. Failure is logged and the landing is unaffected.
   */
  async tryAdvanceLocalIntegration(): Promise<void> {
    try {
      const integration = await this.getIntegrationBranch();

      const statusFn = this.deps.getWorktreeStatus ?? _getWorktreeStatus;
      const { branch: mainBranch, clean } = await statusFn(this.workspaceDir);

      // Resolve the most-advanced SHA (origin > local). No mergeWtPath: the
      // shared __dev-merge is a dead path post-pc-pty-chat-443 fix A.
      const tipFn = this.deps.resolveIntegrationTip ?? _resolveIntegrationTip;
      const sha = await tipFn(this.workspaceDir, integration);
      if (!sha) return; // fresh repo or nothing resolvable — nothing to advance to

      if (mainBranch === integration) {
        if (!clean) {
          console.warn(
            `[worktree] skipped fast-forward of ${integration}: main checkout is dirty`,
          );
          return;
        }
        const ffFn = this.deps.fastForwardWorktree ?? _fastForwardWorktree;
        await ffFn(this.workspaceDir, sha);
        return;
      }

      const updateFn = this.deps.updateRef ?? _updateRef;
      await updateFn(this.workspaceDir, integration, sha);
    } catch (err) {
      console.warn(
        `[worktree] tryAdvanceLocalIntegration failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  // ── private ───────────────────────────────────────────────────────────────

  /**
   * Run the dep-install step in the worktree. Throws on failure — a broken
   * install must not silently hand back a half-provisioned worktree.
   */
  private async provision(wtPath: string): Promise<void> {
    const runner = this.deps.installRunner ?? defaultInstallRunner;
    await runner(wtPath);
  }

  private async refresh(): Promise<void> {
    try {
      await this.list();
    } catch {
      /* best-effort */
    }
  }
}

function normalize(p: string): string {
  return resolve(p).toLowerCase();
}

function nameFromPath(p: string): string | null {
  const segments = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments[segments.length - 1] ?? null;
}

function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/');
}
