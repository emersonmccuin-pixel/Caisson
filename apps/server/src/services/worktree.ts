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
// Provisioning: every worktree is fully dep-installed (pnpm install
// --frozen-lockfile) BEFORE being returned to any caller. This guarantees
// typecheck / build commands inside the worktree have a complete node_modules
// and never false-fail with "Cannot find module" errors (pc-pty-chat-305).

import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';

import {
  attachWorktree as _attachWorktree,
  branchMergedIntoDev as _branchMergedIntoDev,
  createWorktree as _createWorktree,
  deleteBranch as _deleteBranch,
  destroyWorktree as _destroyWorktree,
  ensureDevWorktree as _ensureDevWorktree,
  gitMergeState as _gitMergeState,
  getWorktreeStatus as _getWorktreeStatus,
  listBranchesByPrefix as _listBranchesByPrefix,
  listWorktrees as _listWorktrees,
  mergeBranchIntoDev as _mergeBranchIntoDev,
  pruneWorktrees as _pruneWorktrees,
  pushBranch as _pushBranch,
  type GitMergeState,
  type WorktreeEntry,
} from '@pc/runtime';
import { markWorktreeDestroyed, upsertWorktree } from '@pc/db';

export interface WorktreeRegistry {
  updatedAt: string;
  worktrees: WorktreeEntry[];
}

/**
 * Dep-injection seam for WorktreeService. All fields optional; defaults are
 * the real implementations. Pass overrides in tests to avoid spawning actual
 * git or pnpm processes.
 */
export interface WorktreeServiceDeps {
  /**
   * Run dependency install in a freshly created/attached worktree directory.
   * Default: `pnpm install --frozen-lockfile` (shell: true so pnpm.cmd
   * resolves on Windows).
   */
  installRunner?: (cwd: string) => Promise<void>;
  createWorktree?: (
    workspaceDir: string,
    wtPath: string,
    branchName: string,
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
  /** Override for `mergeBranchIntoDev` (avoids real git in tests). */
  mergeBranchIntoDev?: (workspaceDir: string, branch: string) => Promise<void>;
  /** Override for `pushBranch` (avoids real git in tests). */
  pushBranch?: (workspaceDir: string, ref: string) => Promise<void>;
  /** Override for `gitMergeState` (avoids real git in tests). */
  gitMergeState?: (workspaceDir: string, branch: string) => Promise<GitMergeState>;
  /**
   * Override for `ensureDevWorktree` — skips real git worktree creation in
   * tests. The real impl creates/attaches a worktree on `dev` under `baseDir`.
   */
  ensureDevWorktree?: (workspaceDir: string, devWtPath: string) => Promise<void>;
  /**
   * Override for `getWorktreeStatus` — returns synthetic branch/cleanliness in
   * tests without inspecting a real git worktree.
   */
  getWorktreeStatus?: (wtPath: string) => Promise<{ branch: string | null; clean: boolean }>;
  /** Override for `branchMergedIntoDev` (avoids real git in tests). */
  branchMergedIntoDev?: (workspaceDir: string, branch: string) => Promise<boolean>;
  /** Override for `deleteBranch` (avoids real git in tests). */
  deleteBranch?: (workspaceDir: string, branch: string) => Promise<void>;
  /** Override for `listBranchesByPrefix` (avoids real git in tests). */
  listBranchesByPrefix?: (workspaceDir: string, prefixes: string[]) => Promise<string[]>;
  /** Override for baseDir directory listing (sweep husk scan). */
  listBaseDirNames?: (baseDir: string) => Promise<string[]>;
  /** Override for recursive directory delete (sweep husk removal). */
  removeDirectory?: (path: string) => Promise<void>;
}

/** Names the engine reaps automatically: per-run isolation worktrees only. */
const REAPABLE_NAME_RE = /^(agent|wf)-[A-Za-z0-9._-]+$/;

export interface WorktreeSweepResult {
  /** Registered worktrees removed (branch merged, not in use). */
  removedWorktrees: string[];
  /** Local branches deleted (merged, no worktree, not in use). */
  deletedBranches: string[];
  /** Unregistered leftover directories deleted from baseDir. */
  removedHusks: string[];
  /** Worktrees kept (in use by a run, or branch not merged yet). */
  kept: string[];
}

/**
 * Default install runner: `pnpm install --frozen-lockfile` inside the
 * worktree. Uses shell: true so the pnpm.cmd shim resolves on Windows
 * (mirrors the pattern in scripts/dev-staging.mjs).
 */
function defaultInstallRunner(cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn('pnpm install --frozen-lockfile', {
      shell: true,
      cwd,
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
            `pnpm install --frozen-lockfile failed (exit ${code}) in ${cwd}` +
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
   * @param deps Optional overrides for git primitives and the install runner
   *   (for testing without real git or pnpm processes).
   */
  constructor(
    private readonly workspaceDir: string,
    private readonly baseDir: string,
    deps: WorktreeServiceDeps = {},
  ) {
    this.deps = deps;
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

  async create(name: string): Promise<WorktreeEntry> {
    const wtPath = resolve(this.baseDir, name);
    const createFn = this.deps.createWorktree ?? _createWorktree;
    const entry = await createFn(this.workspaceDir, wtPath, name);
    // Provision BEFORE returning — callers must never see a half-built worktree.
    await this.provision(entry.path);
    upsertWorktree({ name, path: entry.path });
    await this.refresh();
    return entry;
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
   * Tear down a run worktree after its branch has verifiably landed on dev:
   * remove the worktree (force — node_modules is untracked) and delete the
   * local branch. Refuses loudly if the branch is NOT merged — never deletes
   * unlanded work. Called by the workflow merge node after both positive
   * merge receipts; the boot sweep is the backstop for anything missed.
   */
  async teardownAfterMerge(branch: string): Promise<void> {
    const mergedFn = this.deps.branchMergedIntoDev ?? _branchMergedIntoDev;
    if (!(await mergedFn(this.workspaceDir, branch))) {
      throw new Error(
        `TEARDOWN GUARD: branch "${branch}" is not merged into dev — refusing to tear down`,
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
   * Boot-time backstop sweep. Reaps, under this project's baseDir only:
   *  1. registered `agent-*`/`wf-*` worktrees whose branch is merged into dev
   *     and which no live run references,
   *  2. merged local `agent-*`/`wf-*` branches with no worktree left,
   *  3. unregistered leftover directories (husks from interrupted removals —
   *     Windows file locks abort `git worktree remove` partway).
   * Never touches `__dev-merge`, unmerged branches, or in-use paths.
   */
  async sweepStale(inUsePaths: Iterable<string>): Promise<WorktreeSweepResult> {
    const result: WorktreeSweepResult = {
      removedWorktrees: [],
      deletedBranches: [],
      removedHusks: [],
      kept: [],
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

    const mergedFn = this.deps.branchMergedIntoDev ?? _branchMergedIntoDev;
    const survivors = new Set<string>();
    for (const entry of entries) {
      const name = nameFromPath(entry.path)!;
      const branch = entry.branch ?? name;
      if (inUse.has(normalize(entry.path)) || !(await mergedFn(this.workspaceDir, branch))) {
        result.kept.push(name);
        survivors.add(name);
        continue;
      }
      try {
        await this.destroy(entry.path, true);
        result.removedWorktrees.push(name);
      } catch {
        // Locked dir etc. — keep; the next boot sweep retries.
        result.kept.push(name);
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
      if (!(await mergedFn(this.workspaceDir, branch))) continue;
      try {
        await deleteFn(this.workspaceDir, branch);
        result.deletedBranches.push(branch);
      } catch {
        /* best-effort — retried next boot */
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
      } catch {
        /* locked — retried next boot */
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
  async ensureWorktree(name: string): Promise<WorktreeEntry> {
    const pruneFn = this.deps.pruneWorktrees ?? _pruneWorktrees;
    const listFn = this.deps.listWorktrees ?? _listWorktrees;
    await pruneFn(this.workspaceDir);
    const wtPath = resolve(this.baseDir, name);
    const existing = await listFn(this.workspaceDir);
    const match = existing.find((e) => normalize(e.path) === normalize(wtPath));
    if (match) {
      this.cache = { updatedAt: new Date().toISOString(), worktrees: existing };
      upsertWorktree({ name, path: match.path });
      return match;
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
  // ALL merge operations run inside a dedicated, engine-controlled dev
  // worktree (`<baseDir>/__dev-merge/`) — NEVER in `workspaceDir` (the
  // user's main checkout). This eliminates the bug where `git merge` would
  // run in the user's repo regardless of which branch they had checked out
  // or whether their tree was dirty.
  //
  // The dev worktree is a plain `git worktree add <path> dev` — no pnpm
  // install. It is created lazily and reused across merge steps.
  //
  // `mergeBranchIntoDev` additionally asserts that the worktree is on `dev`
  // and clean before touching anything (belt-and-suspenders guard). A
  // violation returns loudly — never silently merges into the wrong place.

  /**
   * Absolute path to the engine-controlled dev merge worktree. Lives under
   * the same `baseDir` as run worktrees but is NOT provisioned with pnpm.
   */
  get devWorktreePath(): string {
    return resolve(this.baseDir, '__dev-merge');
  }

  /** Ensure the dev merge worktree exists and is on `dev`. Idempotent. */
  private async ensureDevWorktreeReady(): Promise<string> {
    const devWtPath = this.devWorktreePath;
    const fn = this.deps.ensureDevWorktree ?? _ensureDevWorktree;
    await fn(this.workspaceDir, devWtPath);
    return devWtPath;
  }

  /**
   * Merge `branch` into dev (`--no-ff`) in the engine-controlled dev
   * worktree (NOT in the user's main working tree). The dev worktree is in
   * detached HEAD at dev's current commit; the merge advances HEAD. Asserts
   * the dev worktree is clean before merging; throws loudly on any violation.
   * Callers should call `mergeState` first for idempotency.
   */
  async mergeBranchIntoDev(branch: string): Promise<void> {
    const devWtPath = await this.ensureDevWorktreeReady();

    // Belt-and-suspenders: assert the dev worktree is in a valid state before
    // any destructive git command. Valid states: detached HEAD (branch === null,
    // our normal creation mode via --detach) or tracking 'dev' directly.
    // Any OTHER branch means something is badly wrong — refuse loudly.
    const statusFn = this.deps.getWorktreeStatus ?? _getWorktreeStatus;
    const { branch: currentBranch, clean } = await statusFn(devWtPath);
    if (currentBranch !== null && currentBranch !== 'dev') {
      throw new Error(
        `MERGE GUARD: dev merge worktree is on branch "${currentBranch}", expected detached HEAD or "dev" — refusing to merge`,
      );
    }
    if (!clean) {
      throw new Error(
        `MERGE GUARD: dev merge worktree has uncommitted changes — refusing to merge into a dirty tree`,
      );
    }

    const fn = this.deps.mergeBranchIntoDev ?? _mergeBranchIntoDev;
    // Pass devWtPath as the cwd — the user's workspaceDir is never touched.
    await fn(devWtPath, branch);
  }

  /**
   * Push `dev` to `origin/dev` from the engine-controlled dev worktree.
   * When the dev worktree is in detached HEAD (the normal case after --detach),
   * pushes `HEAD:dev` so the merge commit (not the stale local `dev` pointer)
   * reaches origin. Call after a verified merge.
   */
  async pushDev(): Promise<void> {
    const devWtPath = await this.ensureDevWorktreeReady();
    const statusFn = this.deps.getWorktreeStatus ?? _getWorktreeStatus;
    const { branch } = await statusFn(devWtPath);
    // Detached HEAD (standard dev merge worktree): push HEAD (the merge commit)
    // to origin/dev. Branch-tracking worktree: push dev normally.
    const refspec = branch === null ? 'HEAD:dev' : 'dev';
    const fn = this.deps.pushBranch ?? _pushBranch;
    await fn(devWtPath, refspec);
  }

  /**
   * Read-only inspection of merge / push state for `branch` relative to
   * `dev`, run from the engine-controlled dev worktree. All checks are
   * non-destructive. MERGE_HEAD is read from the dev worktree (each worktree
   * has its own MERGE_HEAD), so it correctly reflects conflicts that occurred
   * in the dev worktree.
   */
  async mergeState(branch: string): Promise<GitMergeState> {
    const devWtPath = await this.ensureDevWorktreeReady();
    const fn = this.deps.gitMergeState ?? _gitMergeState;
    return fn(devWtPath, branch);
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
