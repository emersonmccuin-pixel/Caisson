// pc-pty-chat-415 (R4) — seal-before-verify git receipts.
//
// One owner for the tiny read-only git probes the deliverable door and the
// verifier share: dirty-tree state, HEAD sha, current branch. Spawn-based,
// timeout-bounded, never throw. `workingTreeStatus` is deliberately TRI-STATE:
// a failed probe is `unknown`, not `clean` — positive receipt over inference;
// the caller decides whether "cannot confirm" blocks (the seal does) or is
// treated as clean (the verification flush barrier does, preserving its
// pre-415 semantics).

import { spawn } from 'node:child_process';

export const GIT_RECEIPT_TIMEOUT_MS = 30_000;

export type WorkingTreeStatus = 'clean' | 'dirty' | 'unknown';

export interface GitReceipts {
  workingTreeStatus(cwd: string): Promise<WorkingTreeStatus>;
  headSha(cwd: string): Promise<string | null>;
  currentBranch(cwd: string): Promise<string | null>;
}

/** Capture stdout of a git command. Resolves null on non-zero exit, spawn
 *  error, or timeout — callers treat null as "could not confirm". */
function gitCapture(args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn('git', args, { cwd });
    const finish = (val: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.on('error', () => finish(null));
    child.on('exit', (code) => finish(code === 0 ? out : null));
  });
}

/** Tri-state working-tree probe: any tracked/staged/untracked change is
 *  `dirty`; a failed probe is `unknown` (never silently `clean`). */
export async function workingTreeStatus(
  cwd: string,
  timeoutMs = GIT_RECEIPT_TIMEOUT_MS,
): Promise<WorkingTreeStatus> {
  const out = await gitCapture(['status', '--porcelain'], cwd, timeoutMs);
  if (out === null) return 'unknown';
  return out.trim().length > 0 ? 'dirty' : 'clean';
}

/** HEAD commit sha, or null when it cannot be read. */
export async function headSha(
  cwd: string,
  timeoutMs = GIT_RECEIPT_TIMEOUT_MS,
): Promise<string | null> {
  const out = await gitCapture(['rev-parse', 'HEAD'], cwd, timeoutMs);
  const sha = out?.trim() ?? '';
  return sha.length > 0 ? sha : null;
}

/** Current branch name, or null when detached / unreadable. */
export async function currentBranch(
  cwd: string,
  timeoutMs = GIT_RECEIPT_TIMEOUT_MS,
): Promise<string | null> {
  const out = await gitCapture(['branch', '--show-current'], cwd, timeoutMs);
  const branch = out?.trim() ?? '';
  return branch.length > 0 ? branch : null;
}

export const defaultGitReceipts: GitReceipts = { workingTreeStatus, headSha, currentBranch };
