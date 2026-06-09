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

import {
  attachWorktree as _attachWorktree,
  createWorktree as _createWorktree,
  destroyWorktree as _destroyWorktree,
  gitMergeState as _gitMergeState,
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

  // ── Merge / push wrappers (pc-pty-chat-270, Chunk A) ──────────────────────

  /**
   * Merge `branch` into dev (`--no-ff`) in the workspace dir. Throws on
   * conflict or failure — callers should call `mergeState` first for idempotency.
   */
  async mergeBranchIntoDev(branch: string): Promise<void> {
    const fn = this.deps.mergeBranchIntoDev ?? _mergeBranchIntoDev;
    await fn(this.workspaceDir, branch);
  }

  /**
   * Push the local `dev` branch to `origin/dev`. Call after a verified merge.
   */
  async pushDev(): Promise<void> {
    const fn = this.deps.pushBranch ?? _pushBranch;
    await fn(this.workspaceDir, 'dev');
  }

  /**
   * Read-only inspection of merge / push state for `branch` relative to `dev`.
   * All checks are non-destructive.
   */
  async mergeState(branch: string): Promise<GitMergeState> {
    const fn = this.deps.gitMergeState ?? _gitMergeState;
    return fn(this.workspaceDir, branch);
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
