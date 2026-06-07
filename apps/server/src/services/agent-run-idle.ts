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

/** Ms since the most recent sign of life. Three independent signals feed the
 *  max: (1) row timestamps (lastActivityAt / readyAt / spawnedAt / queuedAt),
 *  (2) jsonlMtime — the JSONL transcript file's mtime (stale during thinking),
 *  (3) ptyActivityAt — the last PTY-chunk timestamp relayed from the agent host
 *  via run-chunk events (fires continuously during thinking + long tool calls).
 *  Signal (3) prevents false-stall alerts when CC is actively working but has
 *  not yet flushed its JSONL transcript. */
export function computeIdleMs(
  row: AgentRunRow,
  opts: {
    now: number;
    jsonlMtime?: number | null;
    /** Last PTY-chunk epoch-ms from the host's run-chunk events. When present
     *  and newer than the other signals this is the authoritative activity
     *  proof (eliminates false-stall during long thinking / tool calls). */
    ptyActivityAt?: number | null;
  },
): number {
  const lastActivity = Math.max(
    row.lastActivityAt ?? 0,
    row.readyAt ?? 0,
    row.spawnedAt ?? 0,
    row.queuedAt,
    opts.jsonlMtime ?? 0,
    opts.ptyActivityAt ?? 0,
  );
  return opts.now - lastActivity;
}
