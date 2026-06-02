// T2.2 — shared agent-run idle evaluation.
//
// One source of truth for "how quiet is this run, and what does that mean",
// used by BOTH the in-process liveness path and the host-mode reconcile path so
// the stall logic no longer lives in two mode-split copies.
//
//   computeIdleMs(row, {now, jsonlMtime})  → ms since the last sign of life
//
// Two thresholds:
//   WARN_MS  (~3 min)  → non-terminal `stalled` badge (visible, never kills)
//   KILL_MS  (10 min)  → terminal idle-timeout (in-process only until T1.4 makes
//                        host liveness authoritative; host-mode is warn-only)

import type { AgentRunRow } from '@pc/domain';

/** Idle warn window: no activity for this long ⇒ surface a `stalled` badge.
 *  Generous enough that a legitimately-busy run (long tool call, deep thinking)
 *  isn't flagged on every blip. Tune via PC_AGENT_STALL_WARN_MS. */
const DEFAULT_STALL_WARN_MS = 3 * 60_000;

/** Idle kill window: no activity for this long ⇒ wedged, finalize. Matches the
 *  pre-T2.2 liveness-sweep default. Tune via PC_AGENT_IDLE_TIMEOUT_MS. */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export type IdleVerdict = 'ok' | 'warn' | 'kill';

export function resolveStallWarnMs(): number {
  const raw = Number(process.env.PC_AGENT_STALL_WARN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_WARN_MS;
}

export function resolveIdleTimeoutMs(): number {
  const raw = Number(process.env.PC_AGENT_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_TIMEOUT_MS;
}

/** Ms since the most recent sign of life. The JSONL mtime is the live signal
 *  (the tailer also stamps `lastActivityAt`, but without a rev bump, so it can
 *  lag); the timestamps cover the pre-output window before any JSONL exists. */
export function computeIdleMs(
  row: AgentRunRow,
  opts: { now: number; jsonlMtime?: number | null },
): number {
  const lastActivity = Math.max(
    row.lastActivityAt ?? 0,
    row.readyAt ?? 0,
    row.spawnedAt ?? 0,
    row.queuedAt,
    opts.jsonlMtime ?? 0,
  );
  return opts.now - lastActivity;
}
