# P9 — Step 8: retire inference; the FD-17 timeout ladder (scope) — 2026-06-04

**FD-17 (locked):** timeouts ESCALATE before they execute — badge → verify-alive → notify
orchestrator → kill only on wall-clock or confirmed-dead. Idle-kill of working agents dies.

**Owns the two logged live findings (FD backlog):**
1. **ask-trips-watchdog** (S2 live-fire ×2): worker asked via `pc_ask_orchestrator` → answered →
   resume spawn produced no turn within 90s → `firstTurn` watchdog killed it as `idle-timeout`.
2. **deliverable-skip** (P8 smoke, "marco"): worker ended its turn WITHOUT `pc_submit_deliverable`
   → sat silent → 300s idle-kill. Done-signal model depends on prompt compliance; silence ≠ death.

---

## Trace (what can kill a run today)

| # | Site | Default | Fires on | Verdict |
|---|------|---------|----------|---------|
| 1 | `agent-run.ts` idle timer | 5min | running + quiet | ☠ **DELETE** (the FD-17 sentence) |
| 2 | `agent-run.ts` firstTurn watchdog (resume-only) | 90s | resume + no turn | ☠ **DELETE** (finding 1's killer; resume-no-turn falls to the ladder) |
| 3 | `agent-run.ts` wall-clock | 2h | any non-terminal | KEEP (FD-17-sanctioned ceiling; persistent exempt) |
| 4 | `agent-run.ts` spawn-stuck | 2min | spawning never→running | KEEP (positive-receipt spawn failure, not silence-inference) |
| 5 | `low-level-spawn.ts` ready-timeout | 60s | gate never opens | KEEP (same class as 4) |
| 6 | `agent-run.ts` `onSpawnExit` | immediate | process died | KEEP — `unexpected-exit` typed fail. **This is why deleting #1 is safe: dead processes are caught eventless-ly; only alive-but-quiet remains, and that's the ladder's job.** |
| 7 | reconciler host-lost sweep | 2 ticks (running) / 8 (queued) | host doesn't own the run | KEEP (confirmed-dead class) |
| 8 | in-process liveness sweep (10min idle-kill + pid check) | — | — | ☠ **DELETE** — dead code: `index.ts:436` constructs `mode:'host'` only (P2 deleted the in-process spawn path). One-path violation in waiting. Reconciler loses the `'in-process'` mode entirely. |

## Refute corrections (vs the findings' original wording)

- An ask **does** pause the run properly: `pc_ask_orchestrator`/`pc_ask_user` → `recordExplicitPause`
  → status `paused` + `_markPaused` clears the idle timer; reconciler skips paused (FD-14). The
  backlog's interim rule ("pending ask suspends watchdogs") is **already structurally true**.
  What killed S2's builder was the **post-answer resume** (#2), not the wait.
- Rung 1 already exists: `agent-run-stall-warn.ts` badges `stalled` at 3min quiet
  (`PC_AGENT_STALL_WARN_MS`), mode-agnostic, in THE reconciler tick, emit-once per episode,
  clears on activity. The ladder extends this sweep; it does not add a second loop.
- `inspectAgentRun` (agent-run-control.ts) is the existing verify-alive probe shape:
  pid-alive + lastActivity + idleMs + last JSONL action.

## Design — the ladder lives in THE reconciler (one loop, one wake-up)

Silence rungs for a `running`/`spawning` worker (host mode, the only mode):

1. **3min quiet → badge** (exists, unchanged): `stalled` signal → web badge.
2. **5min quiet → verify-alive + notify ONCE per episode** (new, same sweep):
   - probe: host connected + run still in host roster (absence → #7 already owns it) +
     snapshot `turnState` + last JSONL action + idleMs.
   - confirmed-dead cases never reach here (#6/#7 fire first). Alive → mailbox envelope
     **`agent-stalled`** to the orchestrator: pod, idleMs, turnState, last action, run id —
     orchestrator decides (inspect / answer again / cancel / wait). Injection rides the ONE
     marked door (`[pc:…]`).
   - episode resets on activity (badge clears); a fresh quiet spell may notify again.
   - threshold env `PC_AGENT_STALL_NOTIFY_MS`, default 300_000 — **the old kill moment becomes
     the notify moment.**
3. **Kill = wall-clock (2h, #3) or confirmed-dead (#6/#7) ONLY.**

Resume-no-turn (finding 1) needs no special rung: the resumed run is quiet → badge at 3min →
notify at 5min with `turnState`/last-action evidence; orchestrator's observed self-heal
(cancel + re-dispatch or re-answer) is the recovery. No 90s execution.

### Deliverable-skip nudge (finding 2) — event-driven, not polled

On host `run-jsonl` turn-end (G7 `kind` rides the wire) for a **default-policy contract run
still `running` with no submitted deliverable and no pending ask**:

- **1st strike:** host `send` into the run:
  `[pc:system kind=deliverable-nudge] Your turn ended without a deliverable. If the work is
  done, call pc_submit_deliverable now; if you are blocked, call pc_ask_orchestrator.`
  Once per run (in-memory; a duplicate nudge after an API restart is harmless).
- **2nd strike** (next turn-end, still nothing): mailbox **`agent-stalled`**
  (`reason:'no-deliverable'`) to the orchestrator. No kill.
- Marco-class outcome: nudge at ~18s → model files the deliverable → completed. No 300s wait.

### Deletions & guards

- ☠ `armIdleTimer`/`resetIdleTimer`/`clearIdleTimer` + `timeouts.idleMs` arming ·
  ☠ `armFirstTurnWatchdog` + `firstTurnMs` · ☠ `agent-run-liveness-sweep.ts` + reconciler
  `'in-process'` mode + `PC_AGENT_IDLE_TIMEOUT_MS` kill semantics. Banned-resurrection set grows
  the names. `idle-timeout` stays in the failure-cause union for historical row display —
  **no writer remains** (comment + gate).
- G3 policy comments update: idle/firstTurn gating becomes moot (timers gone for everyone);
  wall-clock stays persistent-exempt.
- New host event/command surface: NONE needed for the ladder (server-side probe reads existing
  snapshots). Slice C reuses the existing `send` command. Mailbox kind `agent-stalled` is new —
  client validator / renderer cases swept (set-config burn class).

## Slices

- **A — host surgery:** delete #1/#2/#8; comments; banned names; runtime+host suites.
- **B — ladder sweep:** extend stall-warn into badge→probe→notify; `agent-stalled` mailbox kind +
  orchestrator prompt line; reconciler tests (episode once-ness, un-stall reset, paused skipped).
- **C — nudge:** turn-end-without-deliverable detector in the host-event apply path; strike
  state; tests (nudge once, second-strike notify, ask-in-flight suppresses).

## Verification — RESULTS (live, 2026-06-04, all on the dev stack)

1. ✅ **Acceptance workflow** (file-then-review fire→deliver→gate→approve→completed) green on the
   new code, ~60s e2e.
2. ✅ **Marco class:** verbatim degenerate task → turn ended bare → `[pc:system
   kind=deliverable-nudge]` landed (transcript L10) → agent called `pc_submit_deliverable` (L12)
   → **completed in ~10s** (was: silent death at 300s).
3. ✅ **The full escalation chain, unscripted:** the 6-min-silence test agent backgrounded its
   sleep and ended its turn → strike-1 nudge → it checked the job, then did EXACTLY what the
   nudge says — `pc_ask_orchestrator` → paused (FD-14; ladder skips paused) → strike-2
   `agent-stalled` escalation row durable in the mailbox (`agent-no-deliverable:<runId>`) →
   answered the ask → **resume survived** (the S2 killer — twice-fatal at 90s — is gone) →
   quiet past the 3-min badge window (idle 187s+ observed, run untouched) → delivered →
   **completed at 365s with `delivered_at` set**. One run exercised nudge + ask + pause + resume
   + badge-window survival end-to-end.
4. ✅ **Confirmed-dead still instant:** killed the run's claude.exe mid-essay → `failed /
   unexpected-exit` within ~2s. Deleting the idle-kill cost nothing here.
5. ✅ Suites: runtime 41 · server 251 · agent-host 12 · domain 20 · workspace typecheck ·
   no-bypass + banned-resurrection + ONE-RECONCILER gates green.
6. ⚪ Rung-2 *silence* notify (5-min quiet → `agent-stalled` w/ last-activity-floor key) not
   live-fired — no test run stayed quiet that long while running; covered by 8 unit tests
   (emit-once, episode reset, restart-stable key, paused-skip). Same mailbox door as the
   live-verified strike-2 row.

## Out of scope (breadcrumbs)

- Auto-retry of a resume that didn't land (orchestrator recovery is the path; revisit if notify
  volume shows it's common).
- Wall-clock as a visible setting (FD-15 pattern) — only if Emerson asks.
- Host-lost resume → S5/FD-14 · diary events for escalations → M3.
