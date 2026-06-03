# Step 2 build scope — one reconciler, all states

**Date:** 2026-06-03 · **Wave:** P1 (rebuild-sequencing) · **Ledger:** §2 "Reconcilers / sweeps" + §6 row 2
**FDs:** FD-14 (paused always survives) · FD-12 (one path) · north-star §5 (boot is the same loop)

## Verified as-built (trace 2026-06-03, source-confirmed)

The continuous sweep (`reconcileAgentRunsAgainstHost`) is already the good loop: conservative
host-lost (authoritative-absence + consecutive ticks), full effects via the one terminal authority,
paused never killed, envelope replay. Keep its semantics.

The problems are all at **boot**, in `agent-run-boot-reconcile.ts`:

| # | Finding | Where |
|---|---|---|
| 1 | 🔴 Legacy bulk-fail kills **paused** runs (`['queued','spawning','running','paused']` → failed) — FD-14 violation | `packages/db/repos/agent-runs.ts:272,292` |
| 2 | 🔴 Boot host-reconcile bypasses the one terminal authority — 3 direct `markTerminal` writes (no gate, no settle, no envelope) | `agent-run-boot-reconcile.ts:133,148,192` |
| 3 | 🔴 Terminal host runs processed TWICE at boot (markTerminal in reconcile, then `applyHostTerminalSnapshot` in reattach) — two paths, one job | `agent-run-boot-reconcile.ts:145` + `agent-host-reattach.ts:138` |
| 4 | 🔴 Boot insta-fails host-missing rows with NO tick guard (the sweep's false-positive guard doesn't apply at boot) — the "reattach kills live runs" class | `agent-run-boot-reconcile.ts:192` |
| 5 | 🔴 Stuck-state gap: a `queued`/`spawning` row missing from a reachable host NEVER finalizes (sweep drops its counter) → stuck forever | `agent-host-reattach.ts:314` |
| 6 | Boot kills paused-without-open-ask; the sweep never would (boot ≠ loop inconsistency) | `agent-run-boot-reconcile.ts:181` |
| 7 | Duplicated row-walk helpers across boot + sweep files | both files |

Already-good (preserve, don't regress): boot HOLD on unreachable host (`index.ts:418`), T1.4
host-lost guard, paused-with-ask survives, ONE persistent host event listener.

## The build

**New module `apps/server/src/services/agent-run-reconciler.ts` — ONE loop, boot = first tick.**

- `tick()`: refresh host → unreachable ⇒ **HOLD** (zero state mutation; stall-warn badge only).
  Reachable ⇒ one row-walk: terminal snapshot → `applyHostTerminalSnapshot` (one authority) ·
  status drift → update + announce · missing → tick-counter policy (below). In-process mode: the
  liveness checks (pid-dead / idle) inside the same tick. Stall-warn + envelope replay both modes.
- **Boot** = `await tick({ boot: true })`: same walk, plus the reattach extras (register
  host-backed handles, JSONL backfill, subscribe the ONE event stream). No boot-only reconcile.
- **Missing-row policy (one place):**
  - `running`: authoritative-absence + 2 ticks → `host-lost` (unchanged)
  - `queued`/`spawning`: NEW — same guards, longer threshold (8 ticks ≈ 2 min) → `host-lost`
    (closes the stuck-forever gap; the in-flight terminal path for spawning)
  - `paused`: **NEVER finalized by the reconciler — law (FD-14).** Escalation belongs to the
    ask-watchdog (M4/FD-17), not this loop.
  - in-process `queued` not in `ActiveRunRegistry` for 2 ticks → failed `server-restart`
    (replaces the bulk-fail for the only rows liveness checks can't reach)
- **ONE interval owner** inside the module; `index.ts` boot block + watchdog block collapse to
  `startAgentRunReconciler(...)`.
- All finalizations through `applyAgentRunTerminalEffects`. Zero `markTerminal` outside it.

**Deletes (the old path):**
- `agent-run-boot-reconcile.ts` (whole file — both legacy + host boot paths)
- `@pc/db` `reconcileOrphanedRunningRuns` + `listAndReconcileOrphanedRuns` (the paused-killing bulk-fail)
- the inline watchdog `setInterval` + boot reconcile block in `index.ts`

**Out of scope:** workflow-run boot reconcile (stays fail-closed; resumability = M3/S5) ·
in-process fork deletion (P2) · idle-kill retirement (P9/FD-17).

## Guards (CI)

1. **ONE-RECONCILER** — exactly one liveness interval owner; no import of the deleted module.
2. **HOLD** — unreachable/empty host snapshot ⇒ zero terminal writes (boot AND tick).
3. **PAUSED-SURVIVES (FD-14 law)** — no reconciler path can finalize a `paused` row, any mode, boot included.
4. **Spawning converges** — stuck `spawning` row missing from reachable host finalizes after threshold.

## Behavior change (accepted trade-off)

Runs genuinely lost across a restart now fail ~30 s after boot (via the loop's guarded ticks)
instead of instantly at boot. Buys: a slow-reattaching host can never mass-kill live runs at boot.

## Acceptance

Unit suites green + live loop: restart server mid-run → run reattaches and completes · restart
with paused run → survives + resumes · kill host mid-run → run fails `host-lost` ≈30 s with
orchestrator notify · synthetic-stall-check end-to-end still green.
