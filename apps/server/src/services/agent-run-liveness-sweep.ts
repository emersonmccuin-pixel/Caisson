// Continuous IN-PROCESS agent-run liveness sweep.
//
// The host-mode reconcile sweep (agent-host-reattach.ts) no-ops when there's no
// out-of-process agent host — which is production today. This is the safety net
// for the in-process spawn path: terminal state otherwise depends entirely on
// the live JSONL/exit stream, so a run whose process died without firing the
// exit handler, or that wedged at `ready` with no further output (e.g. a resume
// whose continuation input never landed), sits `running` forever.
//
// Two signals, both conservative (never kill a demonstrably-active run):
//   1. pid persisted + OS process gone   -> failed 'unexpected-exit' (immediate)
//   2. alive (or pid unknown) + no JSONL/activity for the idle window
//                                         -> kill the pid (if any) + 'idle-timeout'
//
// Idempotent: applyAgentRunTerminalEffects bails if the row is already terminal.
// Gated to non-host mode by the caller (index.ts).

import { statSync } from 'node:fs';

import type { AgentRunRow, ULID } from '@pc/domain';
import {
  getProjectById as defaultGetProjectById,
  hasOpenPendingAskForRun as defaultHasOpenPendingAskForRun,
  listNonTerminalAgentRuns as defaultListNonTerminalAgentRuns,
} from '@pc/db';
import { jsonlPathFor } from '@pc/runtime';

import type { ActiveRunRegistry } from './agent-active-runs.ts';
import type { MailboxEnqueuePort } from './agent-delivery.ts';
import { applyAgentRunTerminalEffects } from './agent-run-terminal-effects.ts';
import { isProcessAlive as defaultIsProcessAlive, killProcessTree as defaultKill } from './process-control.ts';

/** Default idle window: no JSONL activity for this long ⇒ wedged. Generous so a
 *  legitimately-busy run (long tool call, deep thinking) is never killed. Tune
 *  via PC_AGENT_IDLE_TIMEOUT_MS. */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export interface LivenessSweepDeps {
  activeRunRegistry?: ActiveRunRegistry;
  /** Mailbox enqueue port — a swept terminal delivers its envelope through it. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  broadcast?: (projectId: ULID, msg: unknown) => void;
  now?: () => number;
  idleTimeoutMs?: number;
  listNonTerminalRuns?: () => AgentRunRow[];
  hasOpenPendingAskForRun?: (runId: ULID) => boolean;
  resolveJsonlPath?: (row: AgentRunRow) => string | null;
  jsonlMtime?: (path: string) => number | null;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
  /** Test seam — defaults to the real terminal-effects pipeline. */
  applyTerminalEffects?: typeof applyAgentRunTerminalEffects;
}

export interface LivenessSweepResult {
  checked: number;
  failedDead: number;
  failedIdle: number;
  killed: number;
}

export function sweepAgentRunLiveness(deps: LivenessSweepDeps = {}): LivenessSweepResult {
  const now = (deps.now ?? Date.now)();
  const idleTimeoutMs = deps.idleTimeoutMs ?? resolveIdleTimeout();
  const rows = (deps.listNonTerminalRuns ?? defaultListNonTerminalAgentRuns)();
  const hasOpenAsk = deps.hasOpenPendingAskForRun ?? defaultHasOpenPendingAskForRun;
  const resolveJsonlPath = deps.resolveJsonlPath ?? defaultResolveJsonlPath;
  const jsonlMtime = deps.jsonlMtime ?? defaultJsonlMtime;
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const kill = deps.killProcess ?? defaultKill;

  let failedDead = 0;
  let failedIdle = 0;
  let killed = 0;

  for (const row of rows) {
    // Not yet spawned — admission/cap layer owns queued runs.
    if (row.status === 'queued') continue;

    // A paused run legitimately has no live process while it waits on a
    // pending ask (Claude exits clean, resumes from JSONL on answer). Leave it.
    if (row.status === 'paused' && hasOpenAsk(row.id)) continue;

    const pid = row.pid;

    // Signal 1: the process is gone but the row never flipped — the exit
    // handler missed it. Unambiguous; finalize immediately (no kill needed).
    if (pid !== null && !isAlive(pid)) {
      finalize(row, 'unexpected-exit', now, deps);
      failedDead += 1;
      continue;
    }

    // Signal 2: alive (or pid unknown) but no activity for the idle window.
    const jsonlPath = resolveJsonlPath(row);
    const mtime = jsonlPath ? jsonlMtime(jsonlPath) : null;
    const lastActivity = Math.max(
      row.lastActivityAt ?? 0,
      row.readyAt ?? 0,
      row.spawnedAt ?? 0,
      row.queuedAt,
      mtime ?? 0,
    );
    if (now - lastActivity > idleTimeoutMs) {
      if (pid !== null && isAlive(pid)) {
        kill(pid);
        killed += 1;
      }
      finalize(row, 'idle-timeout', now, deps);
      failedIdle += 1;
    }
  }

  return { checked: rows.length, failedDead, failedIdle, killed };
}

function finalize(
  row: AgentRunRow,
  cause: 'unexpected-exit' | 'idle-timeout',
  now: number,
  deps: LivenessSweepDeps,
): void {
  (deps.applyTerminalEffects ?? applyAgentRunTerminalEffects)(
    {
      runId: row.id,
      ccSessionId: row.ccSessionId,
      podName: row.podName,
      projectId: row.projectId,
      dispatcherSessionId: row.dispatcherSessionId,
      parentWorkItemId: row.parentWorkItemId,
      worktreeDir: '',
      status: 'failed',
      failureCause: cause,
      completedAt: now,
      startedAt: row.queuedAt,
      // Skip verification — a swept failure isn't a produced report.
      workItemId: null,
      // slug derived from the project inside the effects helper.
      slug: null,
    },
    {
      activeRunRegistry: deps.activeRunRegistry,
      mailboxEnqueue: deps.mailboxEnqueue,
      broadcast: deps.broadcast,
      now: deps.now,
    },
  );
}

function resolveIdleTimeout(): number {
  const raw = Number(process.env.PC_AGENT_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_TIMEOUT_MS;
}

function defaultResolveJsonlPath(row: AgentRunRow): string | null {
  try {
    const project = defaultGetProjectById(row.projectId);
    return project ? jsonlPathFor(project.folderPath, row.ccSessionId) : null;
  } catch {
    return null;
  }
}

function defaultJsonlMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
