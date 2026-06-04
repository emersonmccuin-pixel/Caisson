// Shared agent-run idle evaluation — the stall ladder's one idle calculation
// (P9/FD-17: silence escalates, it never executes).
//
//   computeIdleMs(row, {now, jsonlMtime})  → ms since the last sign of life
//
// Two thresholds, two rungs:
//   WARN_MS    (3 min)  → non-terminal `stalled` badge (rung 1 — visible, never kills)
//   NOTIFY_MS  (5 min)  → verify-alive + ONE mailbox notify to the orchestrator
//                         (rung 2 — the old kill moment became the notify moment)
//
// There is NO kill threshold. Kills happen only on wall-clock (AgentRun, 2h
// default) or confirmed-dead (onSpawnExit / host-lost). ☠ resolveIdleTimeoutMs
// + PC_AGENT_IDLE_TIMEOUT_MS died with the in-process liveness sweep.

import type { AgentRunRow } from '@pc/domain';

/** Idle warn window: no activity for this long ⇒ surface a `stalled` badge.
 *  Generous enough that a legitimately-busy run (long tool call, deep thinking)
 *  isn't flagged on every blip. Tune via PC_AGENT_STALL_WARN_MS. */
const DEFAULT_STALL_WARN_MS = 3 * 60_000;

/** Idle notify window: no activity for this long ⇒ verify-alive + tell the
 *  orchestrator once per stall episode. Matches the old idle-KILL default —
 *  the moment we used to execute the run is now the moment we ask about it.
 *  Tune via PC_AGENT_STALL_NOTIFY_MS. */
const DEFAULT_STALL_NOTIFY_MS = 5 * 60_000;

export function resolveStallWarnMs(): number {
  const raw = Number(process.env.PC_AGENT_STALL_WARN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_WARN_MS;
}

export function resolveStallNotifyMs(): number {
  const raw = Number(process.env.PC_AGENT_STALL_NOTIFY_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_NOTIFY_MS;
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
