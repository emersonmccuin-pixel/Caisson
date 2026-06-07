// In-memory PTY-chunk last-active timestamps, keyed by agent run ID.
//
// The agent host emits `run-chunk` events for every PTY byte the spawned CC
// process writes (spinner redraws, output text, thinking-turn UI — all of
// it). The reconciler taps these events and records the timestamp here so the
// stall sweep (sweepStallWarn / computeIdleMs) has a live proof-of-work
// signal even when the JSONL transcript has not been flushed — CC only flushes
// JSONL at turn-end, so a long thinking turn or long tool call looks idle to
// the file-mtime check while the PTY is actively redrawing.
//
// Throttle: at most one store write per THROTTLE_MS per run. PTY chunks
// arrive every ~100–500 ms; 15 s throttle keeps the write-rate negligible
// while keeping the stored timestamp fresh well inside the WARN_MS (3 min)
// window. A stall-sweep tick always sees an activity age of at most
// THROTTLE_MS + tick-interval ≈ 30 s when the agent is working.
//
// The map is module-level (one singleton per server process). It survives
// host respawns — the host re-streams chunk events on reconnect. It is lost
// on API restart, but that is safe: the stall sweep's WARN_MS is 3 min and
// the reconciler boot tick runs within seconds, so a restart can never
// produce a false stall inside the warning window.
//
// Callers MUST call clearPtyActivity on terminal so the map stays bounded.

/** Throttle window: update the store at most once per run per this interval. */
export const PTY_ACTIVITY_THROTTLE_MS = 15_000;

/** runId → epoch-ms of the last stored PTY-chunk timestamp. */
const store = new Map<string, number>();

/** Record PTY-chunk activity for a run (called from the reconciler's
 *  run-chunk handler). Throttled: skips the write if the stored value is
 *  less than PTY_ACTIVITY_THROTTLE_MS old relative to `at`. */
export function recordPtyActivity(runId: string, at: number): void {
  const prev = store.get(runId);
  if (prev !== undefined && at - prev < PTY_ACTIVITY_THROTTLE_MS) return;
  store.set(runId, at);
}

/** Last recorded PTY-chunk activity epoch-ms for a run, or null if none. */
export function getPtyActivityAt(runId: string): number | null {
  return store.get(runId) ?? null;
}

/** Remove a run from the store. Call on terminal to keep the map bounded. */
export function clearPtyActivity(runId: string): void {
  store.delete(runId);
}
