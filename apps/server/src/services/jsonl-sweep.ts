// Section 18.8 — JSONL retention sweep.
//
// CC writes one `.jsonl` per session under `~/.claude/projects/<encoded-cwd>/`
// and appends forever. Without bounded retention the dir grows unbounded.
// This sweep walks the project subdirectories, finds `.jsonl` files whose
// mtime is older than the retention window, and deletes them.
//
// Mtime, not creation time — a long-lived session resumed last week stays
// alive even if its first event was six months ago. Sessions that haven't
// written in N days were either abandoned or are unreachable (their orchestrator
// chat is closed and the `--resume <uuid>` flow can no longer find them).
//
// Behaviour:
//   - retention='never' → no-op, returns zeros
//   - missing root dir → no-op, returns zeros (fresh install hasn't booted CC yet)
//   - non-fatal per-file errors (already gone, locked by another reader) are
//     counted as `skipped` and don't abort the sweep
//   - non-`.jsonl` files preserved (CC writes `.json` settings files in the
//     same tree)
//
// Wired into apps/server boot. Fire-and-forget — sweep failure must never
// block startup.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface JsonlSweepResult {
  /** Total `.jsonl` files examined across all project subdirectories. */
  scanned: number;
  /** Files older than retention that were successfully unlinked. */
  deleted: number;
  /** Files older than retention that we tried to delete but skipped (already
   *  gone between stat + unlink, EBUSY on Windows, etc.). */
  skipped: number;
  /** Aggregate bytes freed (best-effort; from the stat before unlink). */
  bytesFreed: number;
}

export interface JsonlSweepOptions {
  /** Override the `~/.claude/projects/` root. Tests pass a temp dir. */
  rootDir?: string;
  /** Retention window in days, or the literal `'never'` to opt out. */
  retention: number | 'never';
  /** Anchor time for "older than retention." Defaults to `Date.now()`.
   *  Tests pass a deterministic value. */
  now?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default root: `~/.claude/projects/`. Matches `claudeProjectsRoot()` (path-resolver). */
export function defaultClaudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

export async function sweepStaleJsonl(opts: JsonlSweepOptions): Promise<JsonlSweepResult> {
  const result: JsonlSweepResult = {
    scanned: 0,
    deleted: 0,
    skipped: 0,
    bytesFreed: 0,
  };
  if (opts.retention === 'never') return result;
  const root = opts.rootDir ?? defaultClaudeProjectsDir();
  const now = opts.now ?? Date.now();
  const cutoff = now - opts.retention * DAY_MS;

  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw err;
  }

  for (const name of projectDirs) {
    const projectDir = join(root, name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(projectDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries: string[];
    try {
      entries = await fs.readdir(projectDir);
    } catch {
      continue;
    }
    for (const fname of entries) {
      if (!fname.endsWith('.jsonl')) continue;
      const filePath = join(projectDir, fname);
      let fstat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        fstat = await fs.stat(filePath);
      } catch {
        result.skipped += 1;
        continue;
      }
      if (!fstat.isFile()) continue;
      result.scanned += 1;
      if (fstat.mtimeMs >= cutoff) continue;
      try {
        await fs.unlink(filePath);
        result.deleted += 1;
        result.bytesFreed += fstat.size;
      } catch {
        result.skipped += 1;
      }
    }
  }
  return result;
}
