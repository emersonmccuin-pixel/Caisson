# Slice 015 — State Propagation Spine (relay + WS cursor cut-over + no-bypass gate)

> Status: 015a built (2026-05-31, unit-proven, not yet live-verified — row 51); 015b/015c planned

## Build log

- **015a built 2026-05-31.** Relay + WS `lastVersion` subscribe handshake + outbox prune (size 10k / age 1h) shipped BESIDE the existing hand-fanout (dual delivery; zero behavior regression). Files: `apps/server/src/services/live-relay.ts` (new), `apps/server/src/index.ts` (relay wire + 250ms drain timer + 5m prune timer + boot prime-to-head + `catchUp` dep), `apps/server/src/features/runtime-host/{websocket-server,websocket-message}.ts` (`subscribe` handshake → per-socket `catchUp`), `apps/server/src/features/live-events/routes.ts` (`resetRequired`), `packages/db/src/repos/live-outbox.ts` (`pruneLiveOutbox`/`getLiveEventFloor`/`listLiveOutboxRowsAfter` + `resetRequired` in `listLiveEventsAfter`), `packages/contracts/src/live-events.ts` (`LiveEventSubscribe`/`LiveEventResetFrame` + guards), web `apps/web/src/features/live/hooks.ts` (generic per-scope cursor store), `apps/web/src/hooks/use-project-ws.ts` (send `subscribe`, advance cursor, handle `live-reset`), `apps/web/src/features/projects/live-events.ts` (accept relay frames + `live-reset`). Typecheck exit 0. Tests: db 26/26, server 88/88, contracts 62/62, web 19/19 (all suites green; +12 new 015a tests). Live two-client verification deferred to row 51 (human). 015b (migrate bypassers) and 015c (no-bypass gate) NOT started — the old hand-fanout is intact.

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-05-31 |
| Branch | `refactor/auto-pathway` |
| Artifact status | planned |
| ADR | `archive/docs/state-propagation-decision.md` (adopt verbatim; this slice = its steps 6–8 + WS cut-over) |
| Slice subject | One durable door + reliable delivery; migrate every DB-owned-fact pusher onto it; enforce no-bypass |
| Implementation target | This repo. No parallel app. |
| Scope rule | Build plan only. Do not implement until the user explicitly asks. Do not restart dev servers. |

**Decision (door unification): PROMOTE `live_outbox` to the canonical door. Do NOT add a new `changes` table.**

Justification (grounded):
- `live_outbox` already has the two counters the ADR demands, under different names. `seq` = integer PK autoincrement = the global, gapless, monotonic cursor the ADR calls `version` (`packages/db/src/repos/live-outbox.ts:142-156`, `cursor: String(row.seq)`). The per-row `version` column = the ADR's per-entity `rev` (`packages/db/src/repos/live-outbox.ts:42`, consumed by `use-resource-list.ts:122-133` discard).
- The replay primitives already exist: `insertLiveEvent` (in-txn append, `live-outbox.ts:66`), `listLiveEventsAfter` (cursor `WHERE seq > N`, `live-outbox.ts:91`), `getLiveEventHighWater` (`live-outbox.ts:125`), `GET /api/live-events` route, scope/project filtering, cursor validation.
- The canonical envelope + frame contract exists (`packages/contracts/src/live-events.ts`): `LiveEvent`, `LiveEventFrame`, `buildLiveEventFrame`, 11 registered entities, 12 registered type names.
- Every DB-owned-fact gateway ALREADY writes a `live_outbox` row in the same txn as the business row (work-item / workflow-run / agent-run / pod / mailbox / pending-interaction gateways). Adding a second `changes` table would duplicate this and orphan the existing replay route, web cursor, and tests. The ADR itself says "promote vs new table — recommend"; the code makes promote the obvious call.

What is **missing** (the actual work of this slice): there is no **relay**. Today the door is dual-emitted by hand — the gateway inserts the outbox row, then the call site *separately* calls `broadcast(buildLiveEventFrame(pub.liveEvent))` + a legacy envelope (`workflow-run-writer.ts:47-53`, `index.ts:811-812`, `ask-shadow.ts:85-87`, `mailbox-worker.ts:173-176`). Live delivery does NOT come from the outbox; it comes from ad-hoc `broadcastTo`/`broadcastAll` fanout. The outbox is consulted ONLY by the `/api/live-events` replay route, and only `project.changed` actually replays on the web side (`App.tsx:168-193`). So: the durable write exists, but the *relay-drains-outbox* delivery path and the *per-socket cursor catch-up handshake* do not. That gap is what makes a blipped tab silently miss every non-`project.changed` update.

## 2. Objectives

1. **One relay.** Live delivery flows FROM the outbox, not from hand-written fanout. After a gateway commits a `live_outbox` row, a single relay drains it to subscribed sockets. "Mutation without announcement" is already structurally hard (gateways); make "announcement without delivery" and "delivery without durability" equally impossible.
2. **Per-socket cursor catch-up.** Build the exact ADR subscribe handshake on the WS hub (currently pure fanout, no cursor — `websocket-hub.ts` confirmed). A reconnecting/blipped tab catches up by `lastVersion` and never silently misses.
3. **Gap-detection → full-domain reload.** `lastVersion` below the prune floor → `resetRequired` → client refetches HTTP truth (the existing self-heal, generalized beyond `project.changed`).
4. **Migrate the bypassers.** Every DB-owned-fact pusher delivers via the relay; delete its ad-hoc broadcast.
5. **No-bypass gate.** A static-search test proving no code calls `hub.broadcast`/`broadcastTo`/`broadcastAll`/`fanoutMessage` outside the relay + an explicit pass-through allowlist.

## 3. Honest sub-slice breakdown

- **015a — the door + reliable delivery (infra milestone).** Promote `live_outbox` to canonical; build the relay (drains committed outbox rows → sockets); build the WS subscribe handshake exactly per ADR (client `lastVersion` → server snapshots max `seq` → replays `(lastVersion, snapshot]` → attaches live listener → client dedupes by per-entity `version`); gap-detection → full-domain reload; prune by size/age. This is the milestone that makes "never stale" real for ALL domains at once.
- **015b — migrate the bypassers.** Move every DB-owned-fact ad-hoc push (mailbox, pending-interactions/"Waiting on you", orchestrator runtime + send-queue snapshots, statusline, field-schema, project-claude-md, transient-session lifecycle, work-item/stage/workflow/agent-run legacy envelopes) onto the relay; delete each ad-hoc `broadcast*` as the relay takes it over. One subsystem at a time, each independently shippable.
- **015c — enforce no-bypass + cleanup.** Static-search gate; explicit pass-through allowlist; subsumes the not-yet-written slice 012 cleanup (old Channel/legacy-envelope target deletion is the same bypass-deletion work).

## 4. Pass-through tier — do NOT put on the door

First-class carve-outs (ADR §3, mapping table, Non-goals). These never enter the outbox, have no `rev`/reconcile semantics, and must not share the relay's replay budget:

| Stream | Owner | Why exempt | Code anchor |
|---|---|---|---|
| Live PTY terminal output | Host (live I/O) | Raw byte stream; replayable, latency-class; not a fact to reconcile. Keep heartbeat/reap. | `apps/server/src/features/runtime-host/pty-handlers.ts:116-193` (`run-output`/`state`/`turn-end`/`event`/`exit`) |
| `run-chunk` / `run-jsonl` byte spam | Host (live I/O) | Latency-class; must not dilute the lifecycle/outbox replay budget (overflow = silent gap). | agent-host event stream (`packages/agent-host/src/agent-host-service.ts` `wireRun`); web `chat-session-reducer.ts` |
| Chat transcript (file-tailed JSONL) | Claude CLI (external) | Watch+reconcile, not spine. Outbox carries pointer + rev, never transcript bytes. Its "apply" is render-bytes — no rev semantics. | `runtime-host/routes.ts:84` `sessionReplayPayload`; `chat-bridges/routes.ts:164` `ask` |
| MCP↔pod control `channel-event` | MCP control plane | Not a UI surface — server-to-pod RPC; out of UI-spine scope. | `index.ts:293`; `channel-server.ts:260` `sendEnvelope` |
| Usage / telemetry | API/DB | Separate aggressively-pruned channel; a missed tick is pure latency. Must not share the correctness replay budget. | web `use-global-usage-today.ts` |

## 5. Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified | WS hub is pure fanout — NO per-socket cursor, buffer, replay, or `lastVersion`. `broadcast` injects `projectId`; `broadcastAll` does not. Dead-socket pruning only. | `apps/server/src/services/websocket-hub.ts:14-78` |
| Verified | The door already exists: `seq` (global gapless PK = ADR `version`) + per-row `version` col (= ADR `rev`) + replay route + cursor filter + high-water. | `packages/db/src/repos/live-outbox.ts:66,91,125,142`; `packages/contracts/src/live-events.ts` |
| Verified | No relay. Live delivery is hand-written dual-emit: gateway inserts outbox row, call site separately fans out frame + legacy envelope. | `workflow-run-writer.ts:47-53`; `index.ts:811-812`; `ask-shadow.ts:85-87`; `mailbox-worker.ts:173-176` |
| Verified | Only `project.changed` replays on reconnect. No per-domain hook calls `liveEventsApi.listEvents` — work-items/agent-runs/mailbox/workflows catch live frames only, so a blipped tab misses them. | `apps/web/src/App.tsx:168-193`; only `features/live/client.ts` references the replay API |
| Verified | `broadcastTo`/`broadcastAll` are raw hub fanout, not relay. | `apps/server/src/index.ts:198-208` |
| Verified | ADR steps 1–5 (agent-host reconcile + agent-run `rev`) are ALREADY DONE — ADR's "agent-runs missing rev" is stale. `AgentRunRecord.rev` exists; `agent-run-writer.ts` exists; web uses `getVersion: r => r.rev ?? 0`. | `packages/domain/src/agent-system.ts:113`; `apps/server/src/services/agent-run-writer.ts`; `use-project-agent-runs.ts:40`; migrations 0031/0034 |
| Verified | `live_outbox` has no pruning (slice 002 deferred it); `resetRequired` is structural-only today. | `live-outbox.ts` (no delete path); `live-events.ts:83` |
| Verified | Slices 011 (MCP typed client) and 012 (cleanup) are referenced but NOT written. | `build-slices/` listing; `010-areas.md:5` |

## 6. Bypass inventory (file:line → UI surface → verdict)

Verdict legend: **MIGRATE** = DB-owned fact, move onto the relay/door, delete the ad-hoc push. **KEEP** = legitimate pass-through (see §4). **REWIRE** = already dual-emits a `live_outbox` row; just delete the hand-fanout once the relay delivers it.

| Site | file:line | UI surface | Verdict |
|---|---|---|---|
| Mailbox message/enqueue fanout | `features/mailbox/routes.ts:56-73,104,160,168,176` (`fanoutMessage`, `broadcastTo`/`broadcastAll`) | Mailbox inbox/badges | REWIRE — gateway emits the frame; this is the known-flaky hand-fanout. Delete; relay delivers. |
| Mailbox delivery worker | `services/mailbox-worker.ts:106-176` (`fanout` → `broadcast(buildLiveEventFrame)`) | Mailbox delivery | REWIRE — already builds the outbox frame; delete hand-fanout. |
| Pending-interactions ("Waiting on you") | `services/ask-shadow.ts:40,58,69,79,85-87` (`broadcast(buildLiveEventFrame)`) | "Waiting on you" pending-interaction banner | REWIRE — already a `live_outbox` frame; delete hand-fanout. |
| Workflow-run writer | `services/workflow-run-writer.ts:47-53` (`fanout`: frame + legacy envelope) | Workflow runs panel | REWIRE — outbox row written in gateway; delete frame fanout. Legacy envelope deletion → 015c. |
| Workflow routes create/delete | `routes/workflow-routes.ts:308-312,752-754` (`broadcastAll`/`broadcastTo` frame + env) | Workflow definitions/runs | REWIRE — switch to relay; delete ad-hoc. |
| Agent-run writer / factory / terminal effects | `agent-run-writer.ts`; `agent-run-factory.ts:1019`; `agent-run-terminal-effects.ts:240` | Agent runs roster | REWIRE — outbox row in gateway; delete `broadcast`. |
| Agent-runs routes | `features/agent-runs/routes.ts:233,331,433,559,612,654` (`broadcast: deps.broadcastTo`) | Agent runs | REWIRE — relay delivers. |
| DAG run service | `services/dag-run-service.ts:116,119,525,669,713,714,759` (frames + `work-item-changed`) | Workflow run + work items | REWIRE — gateway emits; delete hand-fanout. |
| Orchestrator review step | `services/orchestrator-review-step.ts:79` (`broadcast`) | Orchestrator review | MIGRATE — confirm a `live_outbox` row is written; if not, add gateway emission, then relay. |
| Project-context (CLAUDE.md changed) | `features/project-context/routes.ts:21,109` (`broadcastTo {type:'project-claude-md-changed'}`) | Project settings panel | MIGRATE — DB-owned fact; add `live_outbox` emission + relay; delete ad-hoc. |
| Field-schema changed | `services/field-schema.ts:32` (`broadcast {type:'field-schemas-changed'}`) | Work-item field schema | MIGRATE — DB-owned; `field-schema` entity already in contract; add door emission + relay. |
| Project-runtime work-item moved | `services/project-runtime.ts:349` (`broadcast {type:'work-item-changed'}`) | Work items board | MIGRATE — route through the work-item gateway so it writes the outbox row, then relay. |
| Work-items routes | `features/work-items/routes.ts:188-195,375,705` (`broadcastTo` work-item/stages) | Work items / stages | REWIRE — `patch()` announces internally (outbox); delete the residual `broadcastTo`; route `stages-changed` through the door. |
| Statusline snapshot | `features/statusline/routes.ts:25,92` (`broadcastTo {type:'statusline-snapshot'}`) | Statusline | MIGRATE-or-SEPARATE — telemetry-adjacent; per ADR, either onto the door OR the separate coalesced channel (§4 usage/telemetry). Decide in 015b (recommend: separate channel; high-frequency). |
| Orchestrator runtime snapshot | `index.ts:213-214` (`broadcastRuntimeSnapshot` → `broadcastTo`) | Orchestrator runtime panel | MIGRATE — ADR maps as "Spine (snapshot)"; stamp per-entity `rev`, ride the door for reconnect catch-up. |
| Orchestrator send-queue snapshot | `index.ts:217-221` (`broadcastSendQueueSnapshot`) | Send-queue panel | MIGRATE — ADR "Spine (full-replace)"; stamp `rev`, ride the door. |
| Transient-session lifecycle | `features/transient-sessions/routes.ts:80-137` (`broadcastTo` session create/etc.) | Transient sessions rail | MIGRATE — DB-owned lifecycle; add door emission + relay (confirm DB-backed first). |
| Runtime-host session-changed / replay | `features/runtime-host/routes.ts:84,227,260,287`; `websocket-message.ts:200-201` (`session-changed`, `sessionReplayPayload`) | Chat sessions rail / transcript | SPLIT — `session-changed` (DB lifecycle fact) = MIGRATE; `sessionReplayPayload` (transcript bytes) = KEEP pass-through (§4). |
| PTY handlers | `features/runtime-host/pty-handlers.ts:116-193` | Terminal/chat live stream | KEEP — pass-through (§4). |
| Chat-bridges `ask` | `features/chat-bridges/routes.ts:164` (`broadcastTo {type:'ask'}`) | Chat ask gate | KEEP — live RPC gate, latency-class; not a reconcilable fact. (Confirm during 015b; the durable record is the pending-interaction row already on the door.) |
| Workflow-compat draft | `features/workflow-compat/routes.ts:69` (`broadcastTo {type:'workflow-builder-draft'}`) | Workflow builder live draft | KEEP — ephemeral builder session echo, not a DB-owned fact. |
| Channel-event (MCP↔pod) | `index.ts:293`; `channel-server.ts:260` | none (server-to-pod RPC) | KEEP — not a UI surface; out of scope. |
| Session-title-updated | `index.ts:703,724` (`broadcastTo {type:'session-title-updated'}`) | Sessions rail title | MIGRATE — DB-owned; small. Onto the door. |
| Project changed dual-fanout | `index.ts:811-812` (`broadcastAll(frame)` + `broadcastAll(legacy)`) | Project rail | REWIRE — the one path already wired end-to-end (outbox + replay). Becomes the relay reference; delete hand-fanout; drop legacy in 015c. |

## 7. WS subscribe handshake mechanism (exact, per ADR §"WS cursor cut-over")

1. **Client → server on (re)connect:** sends its stored `lastVersion` (the `seq` cursor; per project + a global cursor), or none on a cold load that just fetched HTTP truth.
2. **Server:** snapshots current max `seq` (`getLiveEventHighWater`), replays `(lastVersion, snapshot]` from `live_outbox` via `listLiveEventsAfter` ordered by `seq`, **then** attaches the live listener (the relay) — interleave-safe: any live row with `seq ≤ snapshot` is a dup.
3. **Client:** dedupes by per-entity `version` (`use-resource-list.ts:122-133`, already implemented) and by event `id`; advances its cursor to the max `seq` seen.
4. **Gap fallback:** if `lastVersion` is below the prune floor, server returns `resetRequired: true`; client drops its cursor and refetches HTTP truth for the affected domain(s) (generalize `App.tsx:168-193` beyond `project.changed`).

## 8. Contract / DB / Live-event plan

- **DB:** no new table. Add outbox **pruning** (size/age cap, e.g. last 10k rows or 1h) and a `seq`-floor read so the route can compute `resetRequired` (`live-events.ts:83` is structural-only today). Additive; no rewrite of existing rows.
- **Contracts:** extend `LiveEventEntity`/`LiveEventTypeName` (`live-events.ts:4-45`) for the migrated families lacking a type today (`project-claude-md`, `field-schema.list` exists, `statusline`, `runtime-snapshot`, `send-queue`, `transient-session`, `session-title`). Add a subscribe-handshake message contract (`{ type:'subscribe', lastVersion, projectId? }`) and a `resetRequired` reload signal.
- **Relay:** a single post-commit drainer keyed off the outbox. Never call it inside a `db.transaction(...)` closure (ADR Non-goal). Gateways keep their in-txn `insertLiveEvent`; the relay reads committed rows and fans them to subscribers per scope/project.

## 9. Files (by sub-slice)

**015a:**
- `apps/server/src/services/websocket-hub.ts` — add per-socket cursor + subscribe handshake + live-listener attach.
- `apps/server/src/services/live-relay.ts` (new) — drain committed outbox → sockets.
- `apps/server/src/index.ts` — wire relay; replace `broadcastFor`/`broadcastTo` plumbing with relay registration.
- `packages/db/src/repos/live-outbox.ts` — prune by size/age; floor read for `resetRequired`.
- `packages/contracts/src/live-events.ts` — subscribe message + `resetRequired` + new entities/types.
- `apps/web/src/features/live/{client,hooks}.ts`, `apps/web/src/hooks/use-project-ws.ts`, `use-all-projects-ws.ts`, `App.tsx` — send `lastVersion`, dedupe, generalize reload to all domains.

**015b:** the per-site files in §6 (one subsystem per commit).

**015c:** the no-bypass gate test + allowlist; delete legacy envelopes + old Channel target paths (folds in unwritten 012).

## 10. Tests

- DB: prune keeps `(floor, head]`; `listLiveEventsAfter` below floor → `resetRequired`.
- Relay: a committed outbox row delivers to subscribed sockets; rollback delivers nothing; zero subscribers → row stays replayable.
- Handshake: client `lastVersion` → replay `(lastVersion, snapshot]` then live; live row `seq ≤ snapshot` deduped; below-floor → reload.
- Web: per-domain reconnect replay (work-item/agent-run/mailbox/workflow) refetches after a simulated blip — the regression this slice exists to kill.
- No-bypass gate: static search finds zero `broadcast*`/`fanoutMessage` outside `live-relay.ts` + the §4 allowlist.
- Pass-through untouched: PTY/chunk/jsonl/transcript still stream raw; not on the door.

## 11. Verification (manual, two clients)

- Mutate every migrated domain in client A; client B updates with no refresh.
- Block client B's WS, mutate each domain, reconnect → catch-up via `lastVersion`, no missed update (the structural guarantee).
- Force a below-floor cursor → full-domain reload, no stale rows.
- Confirm terminal/chat/transcript still stream live (pass-through intact).

## 12. Migration steps (reconcile/relay-first — ship catch-up BEFORE deleting old paths)

1. 015a: build relay + handshake + prune **alongside** the existing hand-fanout (dual delivery; zero behavior regression). Web starts sending `lastVersion`; per-domain reconnect replay goes live.
2. Verify catch-up works for every domain while old broadcasts still run.
3. 015b: per subsystem, switch delivery to the relay, then delete that subsystem's ad-hoc `broadcast*`. One commit each; revertable in isolation.
4. 015c: add the no-bypass gate; delete legacy envelopes + Channel target paths.

## 13. Rollback

- 015a is additive: relay + handshake run beside the old fanout. Disable the relay → old fanout still delivers; outbox stays replayable.
- Pruning is the only semi-destructive bit — gate behind a generous floor; disable to revert.
- Each 015b subsystem reverts independently (re-add its deleted `broadcast*`).
- Web cursor send is backward-compatible (server ignores absent `lastVersion`).

## 14. Stop conditions

- Do NOT build a second event-log-as-truth, event sourcing, or append-only SQLite (ADR Non-goals).
- Do NOT let the host or anything but the API write SQLite.
- Do NOT push transcript bytes / PTY / chunk / jsonl through the outbox or let them share the relay replay budget.
- Do NOT call the relay/`broadcast` inside a `db.transaction(...)` closure.
- Do NOT conflate `seq` (global cursor) and `version` (per-entity rev).
- Do NOT prune by live-cursor watermark or track durable per-client cursors — size/age only; stale reconnect → full reload.
- Do NOT route usage/telemetry through the correctness replay budget — separate channel.
- Do NOT restart/kill dev servers to verify.

## 15. Sequencing recommendation

**Slot 015 immediately after slice 010 (Areas) and BEFORE 011/012. It is foundational.**

- It is the ADR's steps 6–8; steps 1–5 (agent-host reconcile + agent-run `rev`) are already done (§5), so 015 is unblocked now.
- **012 cleanup logically depends on 015b.** The unwritten 012 ("remove old Channel target paths / legacy envelopes") is the SAME bypass-deletion work as 015c. Recommendation: **fold 012 into 015c** — do not write a separate 012; 015c subsumes it.
- 010 (Areas) is independent (rides the existing dual-emit door) and can ship first without waiting; 011 (MCP typed client) is orthogonal. Build order: **010 → 015a → 015b → 015c (= old 012) → 011.**
- Blast radius is honest and large: 015a rewires how every update reaches every screen. Mitigation is the reconcile/relay-first ordering — ship catch-up beside the old paths, verify, then delete per subsystem. Never delete a broadcast before the relay demonstrably delivers its replacement.

## 16. Open questions

| Question | Status |
|---|---|
| Statusline: onto the door or the separate coalesced telemetry channel? | Recommend separate channel (high-frequency); decide in 015b. |
| `chat-bridges` `ask` frame: keep as live RPC gate (durable record already on the door via pending-interaction) or migrate? | Recommend KEEP; confirm the pending-interaction row fully covers recovery. |
| Orchestrator runtime/send-queue: per-entity `rev` source (no row today)? | Stamp a synthetic snapshot rev; decide shape in 015b. |
| Prune floor (10k rows vs 1h vs both)? | Decide in 015a; default both, whichever hits first. |

## 17. Acceptance criteria

- A single relay delivers all DB-owned-fact live updates from committed `live_outbox` rows; no UI-bound `broadcast*` remains outside the relay + §4 allowlist (proven by the gate).
- The WS subscribe handshake (`lastVersion` → replay `(lastVersion, snapshot]` → live → dedupe by `version`) works for every domain; a blipped tab catches up and misses nothing.
- Below-floor cursor → full-domain reload; outbox prunes by size/age.
- Pass-through streams (PTY, chunk/jsonl, transcript, MCP channel, usage) are explicitly carved out and untouched.
- 010 ships before; 012 is folded into 015c; 011 after.
- Tracker marks this artifact `planned`.
