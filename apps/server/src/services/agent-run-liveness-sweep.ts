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
  listNonTerminalAgentRuns as defaultListNonTerminalAgentRuns,
} from '@pc/db';
import { jsonlPathFor } from '@pc/runtime';

import type { ActiveRunRegistry } from './agent-active-runs.ts';
import type { MailboxEnqueuePort } from './agent-delivery.ts';
import { computeIdleMs, resolveIdleTimeoutMs } from './agent-run-idle.ts';
import {
  applyAgentRunTerminalEffects,
  replayMissingTerminalEnvelopes,
} from './agent-run-terminal-effects.ts';
import { isProcessAlive as defaultIsProcessAlive, killProcessTree as defaultKill } from './process-control.ts';

export interface LivenessSweepDeps {
  activeRunRegistry?: ActiveRunRegistry;
  /** Mailbox enqueue port — a swept terminal delivers its envelope through it. */
  mailboxEnqueue?: MailboxEnqueuePort | null;
  broadcast?: (projectId: ULID, msg: unknown) => void;
  now?: () => number;
  idleTimeoutMs?: number;
  listNonTerminalRuns?: () => AgentRunRow[];
  resolveJsonlPath?: (row: AgentRunRow) => string | null;
  jsonlMtime?: (path: string) => number | null;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
  /** Step 2 — caller-owned consecutive-tick counter for `queued` rows with no
   *  ActiveRunRegistry entry (the in-memory admission layer lost them — i.e.
   *  the server restarted before they spawned). Replaces the legacy boot
   *  bulk-fail: such a row finalizes `server-restart` after
   *  `queuedOrphanAfterTicks` consecutive misses. Absent ⇒ queued rows are
   *  never touched (the original conservatism). */
  queuedOrphanTicks?: Map<string, number>;
  /** Step 2 — finalize an orphaned queued row only after this many CONSECUTIVE
   *  registry-missing ticks (default 2; the false-positive guard for a row
   *  inserted moments before its registry entry lands). */
  queuedOrphanAfterTicks?: number;
  /** Test seam — defaults to the real terminal-effects pipeline. */
  applyTerminalEffects?: typeof applyAgentRunTerminalEffects;
  /** S3 — replay the orchestrator envelope for any recently-terminal run whose
   *  notify tail threw before enqueuing it. Test seam; defaults to the real
   *  idempotent replay. */
  replayEnvelopes?: typeof replayMissingTerminalEnvelopes;
}

export interface LivenessSweepResult {
  checked: number;
  failedDead: number;
  failedIdle: number;
  /** Step 2 — orphaned queued rows finalized `server-restart` this sweep. */
  failedOrphanedQueued: number;
  killed: number;
}

export function sweepAgentRunLiveness(deps: LivenessSweepDeps = {}): LivenessSweepResult {
  const now = (deps.now ?? Date.now)();
  const idleTimeoutMs = deps.idleTimeoutMs ?? resolveIdleTimeoutMs();
  const rows = (deps.listNonTerminalRuns ?? defaultListNonTerminalAgentRuns)();
  const resolveJsonlPath = deps.resolveJsonlPath ?? defaultResolveJsonlPath;
  const jsonlMtime = deps.jsonlMtime ?? defaultJsonlMtime;
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const kill = deps.killProcess ?? defaultKill;
  const orphanTicks = deps.queuedOrphanTicks;
  const orphanAfter = deps.queuedOrphanAfterTicks ?? 2;

  let failedDead = 0;
  let failedIdle = 0;
  let failedOrphanedQueued = 0;
  let killed = 0;

  for (const row of rows) {
    // Queued — the admission/cap layer owns it WHILE a registry entry exists.
    // Step 2: a queued row with NO registry entry was orphaned by a restart
    // (the legacy boot bulk-fail used to catch these); finalize `server-restart`
    // after consecutive confirmed misses. No counter wired ⇒ never touched.
    if (row.status === 'queued') {
      if (!orphanTicks) continue;
      if (deps.activeRunRegistry?.get(row.id)) {
        orphanTicks.delete(row.id);
        continue;
      }
      const ticks = (orphanTicks.get(row.id) ?? 0) + 1;
      orphanTicks.set(row.id, ticks);
      if (ticks < orphanAfter) continue;
      finalize(row, 'server-restart', now, deps);
      orphanTicks.delete(row.id);
      failedOrphanedQueued += 1;
      continue;
    }

    // FD-14 law — the reconciler NEVER finalizes a paused run. It legitimately
    // has no live process while it waits on an ask (Claude exits clean, resumes
    // from JSONL on answer); only the ask flow may end it.
    if (row.status === 'paused') continue;

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
    if (computeIdleMs(row, { now, jsonlMtime: mtime }) > idleTimeoutMs) {
      if (pid !== null && isAlive(pid)) {
        kill(pid);
        killed += 1;
      }
      finalize(row, 'idle-timeout', now, deps);
      failedIdle += 1;
    }
  }

  // S3 — re-emit any terminal run's orchestrator envelope that the fire-and-
  // forget notify tail dropped. Idempotent on `agent:${runId}:${kind}`; runs
  // every tick. Detached: it must not block (or fail) the liveness sweep.
  if (deps.mailboxEnqueue) {
    void (deps.replayEnvelopes ?? replayMissingTerminalEnvelopes)({
      mailboxEnqueue: deps.mailboxEnqueue,
      now: deps.now,
    }).catch(() => {});
  }

  return { checked: rows.length, failedDead, failedIdle, failedOrphanedQueued, killed };
}

function finalize(
  row: AgentRunRow,
  cause: 'unexpected-exit' | 'idle-timeout' | 'server-restart',
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
