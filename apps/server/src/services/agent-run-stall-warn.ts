// T2.2 — non-terminal `stalled` warn pass (mode-agnostic).
//
// The intermediate signal the old two sweeps never had: a run that has gone
// quiet past WARN_MS but is NOT yet killed gets a visible `stalled` badge,
// instead of looking identical to a healthy run until it either resumes or
// jumps straight to `failed` at KILL_MS. Runs in BOTH modes (host + in-process)
// — warn-only, never terminal (the in-process liveness sweep owns the kill; the
// host-mode terminal path is T1.4).
//
// Emit-once via a caller-owned `Set<runId>`: announce `stalled` the first tick a
// run crosses WARN, announce `reconciled` (un-stall) the first tick it drops
// back under WARN, and prune ids that have left the running set. Both emits bump
// rev so they out-version the last frame and land in the version-deduped client
// store (see agent-run-writer.announceAgentRunSignal).

import { statSync } from 'node:fs';

import type { AgentRunRow, ULID } from '@pc/domain';
import {
  getProjectById as defaultGetProjectById,
  listNonTerminalAgentRuns as defaultListNonTerminalAgentRuns,
} from '@pc/db';
import { jsonlPathFor } from '@pc/runtime';

import { computeIdleMs, resolveStallWarnMs } from './agent-run-idle.ts';
import { announceAgentRunSignal as defaultAnnounceSignal } from './agent-run-writer.ts';

export interface StallWarnDeps {
  /** Caller-owned, persists across ticks — tracks which runs we've already
   *  badged so we emit exactly one frame per WARN crossing / un-stall. */
  stalledRuns: Set<string>;
  broadcast?: (projectId: ULID, msg: unknown) => void;
  now?: () => number;
  warnMs?: number;
  listNonTerminalRuns?: () => AgentRunRow[];
  resolveJsonlPath?: (row: AgentRunRow) => string | null;
  jsonlMtime?: (path: string) => number | null;
  /** Test seam — defaults to the real rev-bump + outbox announce. */
  announceSignal?: typeof defaultAnnounceSignal;
}

export interface StallWarnResult {
  checked: number;
  warned: number;
  cleared: number;
}

/** Only spawned, non-paused runs can be "quiet" in the sense we badge: a paused
 *  run waiting on an ask is legitimately idle (and already shows "paused"); a
 *  queued run hasn't spawned. */
function isStallCandidate(status: AgentRunRow['status']): boolean {
  return status === 'running' || status === 'spawning';
}

export function sweepStallWarn(deps: StallWarnDeps): StallWarnResult {
  const now = (deps.now ?? Date.now)();
  const warnMs = deps.warnMs ?? resolveStallWarnMs();
  const rows = (deps.listNonTerminalRuns ?? defaultListNonTerminalAgentRuns)();
  const resolveJsonlPath = deps.resolveJsonlPath ?? defaultResolveJsonlPath;
  const jsonlMtime = deps.jsonlMtime ?? defaultJsonlMtime;
  const announce = deps.announceSignal ?? defaultAnnounceSignal;
  const broadcast = deps.broadcast;

  const liveIds = new Set<string>();
  let warned = 0;
  let cleared = 0;

  for (const row of rows) {
    if (!isStallCandidate(row.status)) continue;
    liveIds.add(row.id);

    const jsonlPath = resolveJsonlPath(row);
    const mtime = jsonlPath ? jsonlMtime(jsonlPath) : null;
    const idleMs = computeIdleMs(row, { now, jsonlMtime: mtime });
    const quiet = idleMs > warnMs;

    if (quiet && !deps.stalledRuns.has(row.id)) {
      announce({ runId: row.id, reason: 'stalled' }, scoped(broadcast, row.projectId));
      deps.stalledRuns.add(row.id);
      warned += 1;
    } else if (!quiet && deps.stalledRuns.has(row.id)) {
      announce({ runId: row.id, reason: 'reconciled' }, scoped(broadcast, row.projectId));
      deps.stalledRuns.delete(row.id);
      cleared += 1;
    }
  }

  // Prune ids that have left the running set (terminal / paused / gone) so the
  // tracking set can't grow without bound. A terminal frame already dropped the
  // card; a re-spawn mints a new ULID, so no stale carry-over.
  for (const id of deps.stalledRuns) {
    if (!liveIds.has(id)) deps.stalledRuns.delete(id);
  }

  return { checked: liveIds.size, warned, cleared };
}

function scoped(
  broadcast: StallWarnDeps['broadcast'],
  projectId: ULID,
): ((event: unknown) => void) | undefined {
  return broadcast ? (event) => broadcast(projectId, event) : undefined;
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
