# Foundational Hardening — Design + Sliced Build Plan

Row 61 deliverable (2026-06-01). Produced from a 4-theme, first-principles research pass
(opus subagents, read-only). This is the **design + build plan**, not a build. It
supersedes the framing in `foundational-hardening-backlog.md` where the code contradicted
it (corrections flagged inline). Build sequence is at the bottom (§6).

**One-line thesis:** the app's flakiness is three foundational gaps, not a pile of bugs —
(1) the server↔host link is a frozen snapshot, not a living connection; (2) there is no
shared transient-vs-terminal failure discipline, so infra blips are fatal and real
failures are invisible; (3) the one-door live-UI model (015/018) is built but not closed
on the client. Theme 4 (pod provenance) is already effectively resolved.

---

## §0 Cross-theme map (what depends on what)

```
THEME 1  HostConnection  ──────────────┐  (keystone; owns the host boundary + health signal)
  T1.1 connection + by-value fix        │
  T1.2 single event-stream owner        │
  T1.3 host-aware kill/cancel           │
  T1.4 host-mode stall detection ───────┼──► needs the connection's authoritative liveness
                                         │
THEME 2  Failure discipline             │
  T2.1 failure-policy + route readiness  │  (independent — build anytime)
  T2.2 unified watchdog + 'stalled' warn │  (mostly independent — warn-only until T1)
  T2.3 host-health surface + terminal ───┘  (DEPENDS on T1.1 liveness)

THEME 3  One-door live-UI (apps/web — disjoint from 1/2)
  T3.1 migrate the 3+1 stragglers
  T3.2 migrate project.changed background scan
  T3.3 step 4 cut + delete timeline retention
  T3.4 client no-bypass gate
  └──► then 017 Phase C (delete the Channel path) unblocks

THEME 4  Pod provenance — DONE bar one 5-line comment fix (fold into any pod session)
```

**Shared primitive — the `host-health` live-event entity.** Theme 1 (UI health signal)
and Theme 2 (T2-B operator-visible "host down") independently arrived at the same artifact:
a global-scope `host-health` frame on the existing 015/018 relay door. **Define it ONCE in
T1.1** (`{state:'connected'|'reconnecting'|'down', hostId, pid, lastError?, since}`), emitted
by the HostConnection; Theme 2's T2.3 consumes/classifies it. Do not invent two.

**Parallelization (per handoff):** Track A = Theme 1→2 (`apps/server`), Track B = Theme 3
(`apps/web`), Track C = slice 013→014. Disjoint code. Hard rules: separate worktree/branch
per track; **only ONE session live-verifies at a time** (one dev stack, one Playwright
browser); ~2 tracks is the token ceiling. Recommended: 61 → **Theme 1 solo** (it makes
agent dogfooding reliable, which every other live-verify depends on), then optionally split
B ∥ C.

---

## THEME 1 — One living `HostConnection`

**First principle:** the agent host is an independent, always-on, restartable process. The
server's link to it must be a dynamic, observable, self-healing connection with the lock
file as the SOLE source of host identity — discovery, liveness, re-discovery, dispatch,
terminal events, kill, and cancel all flowing through ONE conduit.

### What the code actually is today
- **Frozen baseUrl.** `HttpAgentHostClient` (`apps/server/src/services/agent-host-client.ts:321`)
  caches `baseUrl` at construction; never re-resolves. `discoverAgentHostEndpoint`
  (`packages/runtime/src/agent-host-lock-file.ts:75`) runs once, at boot wire-up
  (`index.ts:445`).
- **The real T1-A trigger (correction):** the **dev-supervisor** auto-respawns the host on
  crash *without* restarting the API (`apps/server/scripts/dev-supervisor.mjs:179-198`); the
  respawn binds a fresh OS-assigned port (`packages/agent-host/src/http-server.ts:42`,
  `port:0`) and rewrites the lock → the API's cached baseUrl is dead → every dispatch fails
  `host-unavailable` until the *API* restarts. **In packaged mode the host exit handler does
  NOT respawn at all** (`apps/desktop/src/main.ts:198`) — so T1-A is primarily a *dev-mode*
  repro today; packaged mode just leaves the host dead. Same fix serves both.
- **Capture inconsistency (the structural core).** Consumers split two ways:
  - *by-closure (re-reads live value, correct):* ProjectRegistry `getHostClient`
    (`index.ts:279`), `project-runtime.ts:287`, mcp-bridge (`index.ts:577`), reconcile sweep
    (`index.ts:505`).
  - *by-value (frozen at registration, broken):* work-item routes (`index.ts:1000`),
    agent-run routes (`index.ts:1016`). These bind whatever the client was at boot (or `null`
    if boot found no host) and never see a swap. **Fixing this capture is most of T1-A.**
- **Four independent terminal-event consumers** on one raw stream (T1-D): boot reattach
  (`agent-host-reattach.ts:148`), per-dispatch factory (`agent-run-factory.ts:628`), reconcile
  sweep (`index.ts:512`), workflow spawner (`dag-run-service.ts:196`). Idempotency in
  `applyHostTerminalSnapshot` (`agent-host-reattach.ts:289`) saves correctness today, but
  there is no single owner; the `latestRunStateSnapshot` replay (`agent-run-factory.ts:614`)
  is a patch for a race a single ordered stream wouldn't have.
- **Kill/cancel not host-aware (T1-C).** `/kill` (`agent-run-control.ts:48`) kills `row.pid`
  locally — wrong for host-spawned children → `processKilled:false`, orphaned host compute.
  `/cancel` (`agent-runs/routes.ts:202`) is registry-only → 404 for workflow-spawned subagents
  (they live in `dag-run-service`, keyed by `pcSessionId`, not `ActiveRunRegistry`).
- **No host-mode stall net (T1-B).** The in-process liveness sweep early-returns in host-mode
  (`index.ts:542`); the reconcile sweep only mirrors what the host *reports* and leaves
  host-missing rows "untouched" (`agent-host-reattach.ts:187`) → a wedged run sits `running`
  forever, unsurfaced.
- **Lock file is sufficient.** `{pid, hostId, port, startedAt, protocolVersion}`
  (`agent-host-lock-file.ts:10-16`) covers re-discovery (port), host-id-change detection,
  staleness (pid+startedAt), and protocol gating. The host already exposes `GET /health`
  (`http-server.ts:81`) returning identity — **currently never called by the server.** No
  schema change needed.

### The `HostConnection` contract
One long-lived object replacing the frozen client + scattered discovery:

```ts
interface HostConnection {
  // discovery + identity — lock file is the SOLE source of truth
  currentIdentity(): AgentHostIdentity | null;          // {hostId, pid, startedAt, protocolVersion}
  health(): HostHealth;

  // the ONE conduit (auto re-discover + reconnect on failure / host-id change)
  sendCommand(cmd: AgentHostCommand): Promise<AgentHostCommandResponse>;
  listRuns(): readonly AgentHostRunSnapshot[];           // last-known cache
  refreshRuns(): Promise<readonly AgentHostRunSnapshot[]>;
  onEvent(listener: (e: AgentHostEvent) => void): () => void;  // multiplexed, survives reconnect

  // health signal (UI + watchdog)
  onHealthChange(listener: (h: HostHealth) => void): () => void;
  isConnected(): boolean;
  close(): void;
}

type HostHealth =
  | { state: 'connected';    hostId: string; pid: number; lastOkAt: number }
  | { state: 'reconnecting'; lastError: string; since: number }   // transient (Theme 2)
  | { state: 'down';         lastError: string; since: number };  // terminal (Theme 2)
```

Behavior: (a) discovery = lock file only, baseUrl re-derived from the current `port` on every
reconnect — never cached across a host-id change; (b) liveness = pid-alive + `GET /health` +
hostId/protocol compare (poll on a slow heartbeat or lazily after a command error, behind
backoff to avoid reconnect storms); (c) on any `fetch failed`/`ECONNREFUSED`/`AbortError`/
non-OK → re-discover once, swap baseUrl, retry once; host-id change → re-`hello` +
re-subscribe `/events?after=lastSeq` + `refreshRuns`; protocol mismatch → `down` (fail loud,
never dispatch into an incompatible host); (d) single internal emitter — reattach/factory/
sweep/spawner become *consumers* via `onEvent`, re-emitted after reconnect, so listeners
persist; (e) `onHealthChange` → a global-scope `host-health` outbox row on the 015/018 relay
(see shared primitive above) + optional `GET /api/agent-host/health`.

Every mapped call site migrates: routes move from by-value `hostClient:` props to a
`getHostConnection` closure; the factory switch keys on `isConnected()`; the reconcile sweep
calls `refreshRuns()` (already closure-correct); `/kill` and `/cancel` route host-backed runs
through `sendCommand({type:'cancel'})`; the `latestRunStateSnapshot` patch is deleted once
ordered single-stream delivery is proven.

### Slices (build BESIDE the existing client — reconcile-first)
- **T1.1 — `HostConnection` + fix by-value capture (keystone).** New `host-connection.ts`
  wrapping `HttpAgentHostClient` + discovery; liveness monitor; auto re-discover/reconnect in
  `sendCommand`; persistent multiplexed `onEvent`; health state machine; the `host-health`
  relay frame + UI pill. Keep the existing client-shape so all consumers compile unchanged.
  **Change routes `index.ts:1000/1016` from by-value to a `getHostConnection` closure — this
  alone kills T1-A.** *Live-verify:* dispatch → crash the host (dev-supervisor respawns it on
  a new port) → dispatch again with NO API restart → succeeds; health pill flips and recovers.
- **T1.2 — single event-stream ownership.** Reattach/factory/sweep consume `onEvent`; keep
  idempotent terminal application as the net; delete the `latestRunStateSnapshot` replay.
  *Live-verify:* dispatched + reattached runs each complete exactly once, no double-delivery.
- **T1.3 — host-aware kill/cancel (closes T1-C).** `/kill` routes host-backed runs through
  the connection (no orphaned compute, no `processKilled:false`); `/cancel` host-cancels a
  non-registry host-backed run instead of 404; fold workflow-subagent cancel onto the same
  conduit. *Live-verify:* kill a host run → host child actually dies; cancel a workflow
  subagent → no 404.
- **T1.4 — host-mode stall detection (closes T1-B; pairs with T2.2/T2.3).** Add a host-mode
  idle/stall check (reuse the `lastActivityAt` clock, `agent-run-factory.ts:1039`); surface +
  fail-closed once the connection's liveness is authoritative. *Live-verify:* dispatch a pod
  that hangs → detected, surfaced, finalized — not `running` forever.

Order: T1.1 → T1.2 → (T1.3 ∥ T1.4). Risks: reconnect storms (gate health polling behind
backoff), double delivery during the re-subscribe window (idempotency covers it), protocol
mismatch must be terminal not silent.

---

## THEME 2 — Transient-vs-terminal failure discipline

**First principle:** every cross-process / cross-boot / cross-DB op classifies its failures
— transient (retry/degrade) vs terminal (surface) — and **no stuck state is silent**: a
timeout escalates to a visible, actionable state.

### Corrections to the backlog framing (the code says)
- **T2-A is two bugs, and the dominant one isn't the 500.** Migrations run *synchronously
  before* `server.listen` (`index.ts:129` vs `:1092`), so the DB/routes are wired before the
  socket accepts. The real ~1s restart-window symptom is **TCP connection-refused** (old proc
  gone, new not yet listening), which the client `getJson` (`apps/web/src/api/http.ts:1-5`)
  turns into a thrown error with **no retry** — indistinguishable from a 500. The route's
  blanket 500 (`live-events/routes.ts:38`) is real but secondary. Note `/api/dev/status`
  already degrades gracefully on the client (`DevControls.tsx:49` `catch{}` keep-polling); the
  WS layer already backs off (`use-project-ws.ts`); only the one-shot HTTP cold-load doesn't.
- **T2-B is mis-stated as "swallowed into a generic string."** The dispatch path *does*
  persist typed causes (`host-unavailable` / `host-protocol-error`,
  `agent-run-factory.ts:677-820`) and announces a `failed` live-event. The real gap: **no
  host-health surface**, so a host-down failure is indistinguishable from a pod that ran and
  failed; and the boot-connect failure silently degrades to legacy in-process
  (`agent-host-client.ts:545-548` `.catch(()=>null)`), invisible despite the always-on-host
  design.
- **T2-C the watchdog largely EXISTS** — in-process liveness sweep
  (`agent-run-liveness-sweep.ts:69`, wired `index.ts:541`, 30s, `idle-timeout`=10min via
  `lastActivityAt`) + host reconcile sweep (`agent-host-reattach.ts:190`, wired `index.ts:504`,
  15s). Three first-principles gaps: (1) **no idle watchdog in host-mode** (`index.ts:542`
  early-returns); (2) **no intermediate visible "stalled" state** — it jumps `running`→`failed`
  at 10 min; (3) **two mode-split copies** of stall logic. Host-missing rows are "left
  untouched" (`agent-host-reattach.ts:187`) → `running` forever; only safe to finalize once
  Theme 1 liveness is authoritative.

### What we want
1. **One `failure-policy.ts`** (`apps/server/src/services/` — all consumers are server-side):
   a taxonomy (`transient | terminal` + reason) with `classifyThrow(err)` (SQLITE_BUSY/LOCKED →
   transient db-busy; AbortError/timeout → transient host-blip; ECONNREFUSED → transient
   network; else terminal) and `withTransientRetry(fn, {attempts, baseMs, maxMs})` (exp backoff
   + jitter). Distinct from the existing workflow-node `retry-policy.ts` — keep both.
2. **Route readiness:** DB-read routes hit on cold-load return **503 + Retry-After** on a
   transient throw, not 500 (`live-events/routes.ts` + siblings). **Client `getJson` honors
   503/network-refused with bounded short-backoff retry** — this single change fixes the
   dominant restart-window symptom (and TCP-refused lands here too).
3. **Host-health surface (T2-B):** consume the `host-health` relay frame defined in T1.1; show
   ONE "agent host unreachable" banner instead of N look-alike `failed` cards; the boot-connect
   swallow emits `down` instead of silently degrading.
4. **One mode-agnostic watchdog** (fold the two sweeps into `reconcileNonTerminalRuns`):
   extract `computeIdleMs(row, jsonlMtime)`; two thresholds — `WARN_MS` (~3–5 min) →
   non-terminal **`'stalled'`** signal (new `AgentRunChangedReason`, written to `live_outbox`
   so the card badges "quiet for Nm" — the missing intermediate state, derived from the DB row
   each tick so it survives timeline rebuilds, matching slice-018); `KILL_MS` (existing 10 min)
   → terminal `idle-timeout`; pid-dead / host-lost → terminal `unexpected-exit` /
   `host-lost`/`host-crashed` (causes already in `agent-system.ts:47-48`, currently never
   emitted). The terminal host-mode path **depends on Theme 1** authoritative liveness — until
   then host-mode gets the warn signal only (safe).

### Slices
- **T2.1 — failure-policy + route readiness (independent; build first/parallel).**
  `failure-policy.ts`; transient→503+Retry-After on DB-read routes; `getJson` bounded retry.
  *Live-verify:* restart the stack with the UI open → no console errors / no thrown
  live-events cold-load during the window; panel repopulates with no manual refresh.
- **T2.2 — unified watchdog + non-terminal `'stalled'` warn (mostly independent).** Fold the
  two sweeps; `computeIdleMs`; `'stalled'` reason + badge; add host-mode idle warn (warn-only
  until T1). *Live-verify:* let a run idle past WARN_MS → card badges "stalled" live, still
  flips to the right terminal state at KILL_MS.
- **T2.3 — host-health surface + terminal host-mode stall (DEPENDS on T1.1).** Consume
  `host-health`; banner; boot-connect emits `down`; finalize host-lost runs once liveness is
  authoritative (removes the "left untouched" conservatism). *Live-verify:* kill the host
  mid-run → UI shows "host down" within a tick; the run escalates to a surfaced `host-lost`,
  not forever-`running`; host recovery flips the banner back.

Sequence: T2.1 ∥ T2.2 (no Theme-1 dep) → T2.3 on top of Theme 1.

---

## THEME 3 — Finish the one-door live-UI model (the 015→018 arc)

**First principle (locked by 015/018):** ONE durable server door (`live_outbox`→relay) and
ONE identity-keyed client store (`apps/web/src/store/live-store.ts`); the chat timeline is
chat-only; nothing reaches the UI another way.

### What's actually unfinished
- **The store is already fed straight from the socket** (`use-project-ws.ts:265`
  `applyEnvelope`), reconcile-first — but the **same frame is ALSO dispatched into the chat
  reducer** (`:307`), admitted to the timeline (`chat-session-reducer.ts:142-143`), and
  retained across session resets (`shouldPreserveProjectEventAcrossSessionReset:463`). That
  double-carry is what step 4 removes.
- **Three stragglers still positional-scan `events[]`** (T3-A): `use-rich-link-invalidator.ts:19`
  (per-id cache eviction — `work-item` + `attachment`), `use-mailbox-inbox.ts:53` via
  `scanMailboxLiveEvents` (`mailbox-message` + `pending-interaction`, + the project-less global
  inbox), `SessionsRail.tsx:81` (`[...events].reverse().find` for `session-title` +
  `session-changed`).
- **A hidden 4th consumer (not in the backlog):** App.tsx:146-165 scans **`backgroundWs.events`**
  (a separate socket fleet, `use-all-projects-ws.ts`, that does NOT feed the store) for
  `project.changed`. Step 4 must migrate this too or it breaks project-list refresh.
- **`mailbox-delivery` is deliberately not a `LiveEventEntity`** (`mailbox.ts:399-402` carries
  `entity:'mailbox-message'`). So message-changed and delivery-changed frames for the same
  message **collide on the same store key** and version-dedup against each other — a real
  hazard. **Fix at the writer (give delivery frames a distinct `entityId`), NOT by inflating
  the union** (re-plumbing the union/guard/replay filter is high blast radius for a
  refetch-only consumer).
- **No client-side no-bypass gate** (T3-C) — the server has `apps/server/test/no-bypass-gate.test.ts`;
  the client has nothing stopping a future view from re-introducing a positional scan.
- **017 Phase C** (delete `delivery-routing.ts` + the Channel fallback in `agent-delivery.ts`)
  is blocked until the client door is the sole door, structurally enforced both ends.

### Slices (reconcile-first — migrate before deleting)
- **T3.1 — migrate the 3 stragglers (no deletions).** rich-link → `useLiveEvents('work-item')`
  + `useLiveEvents('attachment')` with a version-keyed evicted-set; mailbox →
  `useLiveEntitySignature('mailbox-message')` + `('pending-interaction')`, **add a
  `useLiveGlobalSignature(entity)` selector** for the project-less inbox, fix the writer
  `entityId` collision for delivery frames; SessionsRail →
  `useLiveEntitySignature('session-title')` + a reducer `session-changed` nonce (session-changed
  is a chat-lifecycle envelope, legitimately NOT a relay fact — keep it off the timeline scan
  but consume it from typed reducer state). *Live-verify the exact 018 bar after each.*
- **T3.2 — migrate the `project.changed` background scan.** Feed `useAllProjectsWs` frames into
  the store; refetch off `useLiveEntitySignature('project', null)` (global scope).
- **T3.3 — step 4 cut + delete retention.** `return` on `live-event` in the WS handler before
  `dispatchSession`; delete the reducer admission branch (`:142-143`) + the
  `shouldPreserveProjectEventAcrossSessionReset` retention; drop the vestigial `_events` param.
  Add a unit test asserting the reducer timeline does NOT grow on a `live-event` frame.
- **T3.4 — client no-bypass gate.** `apps/web/test/no-bypass-gate.test.ts` — a source-grep
  static test mirroring the server's (bans a file referencing both an `events`/`_events` array
  AND `isLiveEventFrame`/`is*ChangedLiveEventFrame`/`'live-event'`; allowlist = `use-project-ws.ts`,
  `live-store.ts`, and `chat-session-reducer.ts` *until T3.3 self-cleans it*; exclude
  `*/live-events.ts` guard modules + `test/`; include the planted-bypass self-check).
- **→ 017 Phase C unblocks** (separate slice, lands in row 62): delete `delivery-routing.ts` +
  its `mode(flow)` branches across the agent paths; delete the Channel fallback in
  `agent-delivery.ts` (`readTransportMode`, `channel-only` branches, `channelServer.emitToSession`),
  keep the external-webhook ingest route routed unconditionally to mailbox; tighten the server
  gate. (Host-aware kill/cancel that Phase C also lists = Theme 1 T1.3 — already covered.)

018 live-verify bar (apply to T3.1–T3.3): during a live active agent session, no manual
refresh — a mailbox message/answer/dismiss updates the inbox; a rich-link target re-renders
after its change; a session-title change re-orders/renames the rail; a project add/rename
refreshes the list — all while the chat timeline is re-deriving. T3.3 additionally: the
reducer timeline no longer grows on live-event frames.

---

## THEME 4 — Pod provenance (effectively DONE)

Research verdict: the three pod-content files are **committed and clean** (commit
`c390a299` "Curate stock-pod tool surfaces…"); the "edits from nowhere" was an observed
mid-edit window, since closed. **Keep them.** Pod content is correctly **source-owned**
(TS consts → boot `seedStockPods`/`seedOrchestratorPodIfMissing`, `index.ts:142,169` → DB
`agents` rows via insert-or-drift-reseed, `pod-seed-with-drift.ts:54`; `tools_json` = grants
only; definitions stay in `@pc/domain` — matches the locked "MCP tools stay CODE" invariant).
Source→DB divergence is one-directional and intended (user edits shadow source until "Reset
to default," surfaced via boot warn + the "Customized" pill). **Do NOT move pod content to
the DB; do NOT build a manifest/drift-CLI** — git is the manifest for a single-user local app.

**Lock this rule:** *Stock + orchestrator pod content is source-owned in `*-pod-content.ts` /
`stock-pod-seed.ts`; the DB row is a seeded materialization with a user-override lock.
`tools_json` holds grants; tool definitions live in `@pc/domain`.*

- **T4-A (the only real task, ~5 lines, fold into any pod-touching session):** the
  `stock-pod-seed.ts:7-15` module header documents an **obsolete** "INSERT IF NOT EXISTS, no
  auto-reseed, no drift warnings" contract — the **opposite** of the live `seedPodWithDriftReseed`
  behavior. Rewrite it to describe insert-or-drift-reseed. Pure comment fix, no logic.

---

## §6 Sliced build plan — sequenced by leverage

Each slice = its own build session (opus plan+build subagents) + gates (`pnpm typecheck` +
touched tests, re-run by Claude — never trust subagent/IDE-diagnostic reports mid-build) +
live-verify, reconcile-first (ship beside, verify, then delete). These become the row-62
build slices.

| # | Slice | Track | Depends on | Closes | Leverage |
|---|---|---|---|---|---|
| 1 | **T1.1** HostConnection + by-value fix + host-health frame | A (server) | — | T1-A | **Highest** — reliable dispatch; unblocks every live-verify |
| 2 | **T1.2** single event-stream owner | A | T1.1 | T1-D | High — removes race patches |
| 3 | **T1.3** host-aware kill/cancel | A | T1.1 | T1-C | Med |
| 4 | **T2.1** failure-policy + route readiness + client retry | A | — | T2-A | High — kills the restart-window console errors (independent; can go first/parallel) |
| 5 | **T2.2** unified watchdog + `'stalled'` warn | A | (T1 for host-terminal) | T2-C (warn) | Med |
| 6 | **T1.4 + T2.3** host-mode stall terminal + host-health surface | A | T1.1, T2.2 | T1-B, T2-B, T2-C | Med — pair them (same liveness substrate) |
| 7 | **T3.1** migrate the 3 stragglers | B (web) | — | T3-A | High — mailbox is the flakiest surface |
| 8 | **T3.2** migrate `project.changed` background scan | B | — | hidden 4th | Med |
| 9 | **T3.3** step 4 cut + delete timeline retention | B | T3.1, T3.2 | T3-B | High — closes the double-carry |
| 10 | **T3.4** client no-bypass gate | B | T3.3 | T3-C | Med — structural lock |
| 11 | **017 Phase C** delete the Channel path | B | T3.3, T3.4 | the cutover | High — finally one path |
| 12 | **Slice 013** agent contracts first-class | C | — | rows 44–46 | (pre-drafted) |
| 13 | **Slice 014** reliable deliverables | C | 013, T1 | rows 47–49, tier-1 verifier gap | needs T1 for live-verify |
| — | **T4-A** stale header comment | any | — | T4-A | trivial — fold in |

**Recommended execution across fresh sessions:**
1. **T1.1** (solo — keystone). 2. **T1.2 + T1.3**. 3. Optionally split: **Track B** (T3.1→T3.2→
T3.3→T3.4→017 Phase C) ∥ **Track A cont.** (T2.1, T2.2, then T1.4+T2.3). 4. **Track C** (013→014;
014 waits on T1). 5. **T4-A** folded into any session that touches pods.

**Standing constraints:** separate worktree/branch per parallel track; ONE live-verify at a
time; never restart the stack unasked; the dev-supervisor respawns the host on a new port (the
T1-A repro path) — use it to live-verify T1.1.
