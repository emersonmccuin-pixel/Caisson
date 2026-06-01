# Foundational Hardening Backlog — first-principles, not hole-patching

Created 2026-06-01 (out of the slice-018 verification session). This LOCKS the open
issues discovered + the carried-over ones in the same seams, and frames them the way the
user asked: **don't patch the symptom — find the underlying foundational fault and fix
the foundation.** Each concrete issue below is a *symptom*; the THEMES are the actual
work. The next step is a holistic research+scope pass (tracker row 61) that decides the
foundational design before any build.

## How to read this
- **Symptoms** are locked with evidence so nothing is lost.
- **Themes** are the first-principles groupings — "what do we actually want here."
- A symptom is only "resolved" when its theme's foundation is fixed, not when the
  individual error stops reproducing.

---

## THEME 1 — The server↔agent-host boundary is a snapshot, not a living connection
**First principle:** the agent host is an independent, always-on, restartable process. The
server's link to it must be a *dynamic, observable, self-healing* connection with ONE
source of truth for host identity (the lock file) — discovery, liveness, re-discovery,
dispatch, terminal handling, and kill/cancel all flowing through that one connection.
Today it is a static client captured once at boot, with several independent gaps bolted
on around it. **This is the highest-value foundation to fix; most agent flakiness lives
here.**

Root cause confirmed in code: `HttpAgentHostClient` (`apps/server/src/services/agent-host-client.ts:303`)
fixes `baseUrl` at construction and never re-resolves it. `discoverAgentHostEndpoint`
(`packages/runtime/src/agent-host-lock-file.ts`) is only consulted at wire-up.

Symptoms locked under Theme 1:
- **T1-A (HIGH, discovered 2026-06-01):** server caches a stale host endpoint. Host
  restarts onto a new port → the cached `baseUrl` is dead → **every** dispatch fails
  `host-unavailable` until the *server* restarts. Evidence: host healthy (pid 8308,
  `127.0.0.1:55117/health`→200, lock `data/agent-host/host.lock.json`) yet `…/agents/writer/invoke`
  returned `{cause:"host-unavailable","start-run failed: fetch failed"}`; a server restart
  fixed it. Symptom-level fix would be "re-read the lock on fetch failure" — but the
  *foundation* is that there is no connection object owning discovery+liveness+reconnect.
- **T1-B (MED, re-confirmed 2026-06-01):** dispatched agent goes `running` and never
  completes a trivial task (writer, one-word "pong", still `running` at ~90s/rev 3; had to
  `/cancel`). Same pattern previously seen with a researcher idle-timeout. Host spawned the
  run but the task never progressed/terminated, and nothing detected or surfaced the stall.
- **T1-C (carried over):** kill/cancel is not uniformly host-aware — `/agent-runs/:id/cancel`
  has 404'd for some host-backed / workflow-spawned runs; `/kill` can leave host compute
  orphaned (`processKilled:false`). (Cancel worked in the 2026-06-01 test, but the family
  gap stands.)
- **T1-D (carried over):** boot-wired host-terminal handlers (reattach / reconcile sweep /
  liveness) historically raced the gated factory handler and intercepted live terminals to
  the wrong delivery path (slice-008/009 history). Indicates terminal handling is spread
  across several boot-order-sensitive call sites rather than one path.

**What we want (Theme 1):** a single `HostConnection` abstraction that (1) owns endpoint
discovery from the lock file as the sole source of truth, (2) detects liveness (pid +
`/health` + protocol version), (3) auto-re-discovers + reconnects on any fetch failure or
host-id change, (4) is the ONE conduit for dispatch / list-runs / terminal events /
kill / cancel (no parallel boot handlers), and (5) exposes a host-health signal to the UI
so "host down" is *visible*, never a silent dispatch failure. Liveness/terminal/kill stop
being independently-bolted-on features and become methods on the connection.

---

## THEME 2 — No failure-mode discipline: transient vs terminal, surface vs swallow
**First principle:** every cross-process / cross-boot / cross-DB operation must classify
its failures — *transient* (retry or degrade) vs *terminal* (surface) — and **no stuck
state may be silent**: a timeout must escalate to a visible, actionable state. Today
transient infra errors surface as hard 500s, real failures get swallowed into generic
strings, and stalls (T1-B) are invisible.

Symptoms locked under Theme 2:
- **T2-A (LOW, discovered 2026-06-01):** `GET /api/live-events` and `/api/dev/status`
  return **500** during the ~1s server-boot window (client reconnect hits a not-yet-ready
  server). Route returns 500 for any non-cursor throw (`live-events/routes.ts:38`). A
  transient should be a retryable 503 or a graceful degrade, not a 500.
- **T2-B:** `host-unavailable` (T1-A) is swallowed into a generic dispatch-failure string
  with no operator-visible "the host is down / unreachable" state. The failure is real but
  invisible until you read a JSON error.
- **T2-C:** a stalled run (T1-B) neither completes, errors, nor surfaces — there is no
  watchdog turning "running too long with no progress" into a visible state.

**What we want (Theme 2):** one shared classification + policy — transient infra errors
(boot windows, SQLite contention, host blips) retry/degrade with backoff; terminal errors
surface with a real message; and a run watchdog that escalates stalls to a surfaced state.
Errors become observable and self-correcting instead of either fatal or silent.

---

## THEME 3 — Finish the one-door live-UI model (the 015→018 arc)
**First principle (already locked by slices 015/018):** ONE durable server door
(`live_outbox` → relay) and ONE identity-keyed client store; the chat timeline is
chat-only; nothing reaches the UI another way. 018 proved the client store; the arc isn't
closed.

Symptoms / unfinished work locked under Theme 3:
- **T3-A:** three consumers still read the old positional chat-timeline scan —
  `use-rich-link-invalidator` (per-id eviction), mailbox `scanMailboxLiveEvents` (3
  entities incl. `mailbox-delivery`, which isn't even in the `LiveEventEntity` union, +
  global inbox; **historically the flakiest surface → highest value**), `SessionsRail`
  session-title.
- **T3-B:** plan **step 4** not done — live-events still ride the chat-session reducer
  (`shouldPreserveProjectEventAcrossSessionReset`) in parallel with the store; the timeline
  still double-carries them.
- **T3-C:** the no-bypass discipline is server-side only — there is no client-side gate
  preventing a future view from re-introducing a bespoke positional scan.

**What we want (Theme 3):** complete the migration, pull live-events fully off the chat
timeline, and extend the "one door" enforcement to the client (a lint/gate so no view can
scan `events` for domain frames again). Then 017 Phase C (delete the old Channel path)
unblocks.

---

## THEME 4 — Provenance / seed-vs-source hygiene (minor)
- **T4-A (loose end, 2026-06-01):** three pod-content source files
  (`orchestrator-pod-content.ts`, `stock-pod-seed.ts`, `workflow-builder-pod-content.ts`)
  were modified mid-session by a parallel actor (caisson pod gaining direct
  workflow-authoring), uncommitted, origin unconfirmed. **First-principles question:** how
  is parallel work + any seed↔source sync surfaced so edits don't appear "from nowhere" in
  a dirty tree? Decide keep/discard + whether seeded pod content should live in source at
  all. Low priority; flagged so it isn't lost.

---

## Holistic research+scope pass (what the next step must produce)
Before building, take the whole-app view and answer, per theme:
1. **Map every server↔host call site** (dispatch, list-runs, reattach, reconcile sweep,
   liveness, kill, cancel, terminal-effect) → does it route through one connection? Where
   are the boot-order races? Design the `HostConnection` contract + its UI health signal.
2. **Inventory every cross-boundary failure path** (host fetch, DB read during prune/boot,
   replay cursor) → define the transient/terminal classification + retry/degrade policy +
   the run watchdog.
3. **Finish the live-UI door** — migrate T3-A, do step 4 (T3-B), add the client-side
   no-bypass gate (T3-C).
4. Decide T4-A (pod seed-vs-source).
Output: a foundational design doc + sliced build plan (these become real build slices,
sequenced by leverage: Theme 1 first — it unblocks reliable agent dogfooding).
