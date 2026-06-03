# Live Events & Relay

> **Role:** cross-cutting (Store write side → UI delivery)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `apps/server/src/services/live-relay.ts` · `websocket-hub.ts` · `channel-server.ts` · `packages/db/src/repos/live-outbox.ts` · `packages/contracts/src/live-events.ts` · `packages/app-services/src/agent-runs/run-gateway.ts` · `apps/server/src/features/live-events/routes.ts` · `apps/web/src/store/live-store.ts` · `apps/web/src/features/live/hooks.ts` · `channel-server/server.js`

---

## What it is (plain English)

Think of it like a news ticker for the app's own database. Whenever something important changes — an agent run finishes, a card moves, a workflow advances — the app writes the change to the database AND drops a small announcement into an "outbox" list, in the same instant. Every 250ms a background relay reads any new announcements and pushes them to every open browser tab. Each tab keeps the latest version of each item in memory, so the screen always reflects what the database actually says.

The change and its announcement are written together, in one database operation. That means: if the change rolls back, the announcement disappears with it. Nothing ever reaches a browser tab unless the underlying fact is durably saved.

---

## What it's supposed to do (intent)

Own the single path from "a fact was written to the database" to "every open browser tab sees it." Two laws: **a browser never sees a change that rolled back** (outbox write is part of the same transaction) · **if no tab is connected the announcement waits in the outbox** (it's not lost — it can be replayed when the tab reconnects).

---

## The parts (every component, plain English)

### 1. The outbox — writing the change and its announcement together

When any service changes something the UI cares about, it does two things in one database transaction:

1. Write the actual change (the agent run row, the card, the workflow state, etc.).
2. Call `insertLiveEvent(tx, draft)` to drop an announcement row into the `live_outbox` table. (`live-outbox.ts:90`)

Each announcement row carries: a unique ID (ULID), a gapless sequence number (the cursor the relay advances), scope (`'project'` or `'global'`), project ID, event type (e.g. `'agent.run.changed'`), entity kind + ID, a version number (used to deduplicate), and a JSON payload.

A scope rule is enforced at insert time: global announcements must carry no project ID; project announcements must carry one. (`live-outbox.ts:298`)

**Mutation gateways** wrap this pattern for the high-churn domains. For example, `AgentRunMutationGateway` (`run-gateway.ts:71`) takes the mutation + the outbox insert and wraps both in one `getDb().transaction()` call. It returns the committed row + a data object only after the transaction commits; a rollback produces nothing. The same pattern is mirrored for work items and workflow runs. Simpler domains (workflow definitions, stages, pods, etc.) call `insertLiveEvent(tx, draft)` directly inside their own transaction (`workflow-routes.ts:273`).

> ⚠️ **Critical rule (documented in `live-relay.ts:12` and `index.ts:222`):** the drain loop must never run inside a `db.transaction()` closure — it reads rows and can only see them after the transaction returns.

### 2. The relay loop — the 250ms reader

`LiveRelay` (`live-relay.ts`) is the background reader. It starts once when the server boots (`index.ts:223`). At startup it snapshots the current high-water mark so it doesn't flood clients with history (`live-relay.ts:81`). Then a `setInterval` at 250ms calls `liveRelay.drain()` unconditionally (`index.ts:793`).

`drain()` is safe to call while another drain is already running — it sets a `redrain` flag and runs one extra pass; it doesn't stack. (`live-relay.ts:89`)

Each pass reads the outbox in batches of 500 rows, advancing an in-memory cursor as it goes. For each row it calls `fan()`, which wraps the row in a `LiveEventFrame` (`{ type: 'live-event', event: ... }`) and routes it: global scope → send to all connected sockets; project scope → send to all sockets subscribed to that project. (`live-relay.ts:122`)

### 3. The WebSocket hub — project subscriptions

`ProjectWebSocketHub` (`websocket-hub.ts`) is the in-memory map that tracks which browser tabs are connected to which project. It is a `Map<projectId, Set<socket>>`. Multiple tabs for the same project all subscribe at once; a tab reload must not knock out another surviving tab. (`websocket-hub.ts:13`)

`subscribe(projectId, socket)` returns an unsubscribe function called on socket close. `broadcast(projectId, msg)` serialises to JSON and sends to every open socket for that project, pruning dead sockets as it goes. `broadcastAll(msg)` sends to every socket on every project. A 30-second keepalive sweep (`websocket-server.ts:157`) pings each client and drops any that haven't replied since the last pass, so sockets that went dead silently (NAT timeout, laptop sleep) are reaped.

Browser tabs connect to `/ws?projectId=<id>&intent=chat` on the main API port (`:4040` dev / `:4060` packaged). When a socket connects, it's subscribed to the hub and dispatched to the message handler. (`websocket-server.ts:187`)

### 4. The event frame — what the browser actually receives

Every announcement delivered over WebSocket is wrapped in a `LiveEventFrame`: `{ type: 'live-event', event: LiveEvent }`. (`contracts/src/live-events.ts`) This is the canonical wire shape. When the browser sees this frame it hands it to the live store.

On every (re)connect, the browser sends a subscribe message `{ type: 'subscribe', lastVersion?: string, projectId? }`. (`contracts/src/live-events.ts:98`) The server uses `lastVersion` to drive catch-up (see below).

There is also an HTTP replay route — `GET /api/live-events?after=<cursor>&projectId=<id>&includeGlobal=1&limit=<n>` (`features/live-events/routes.ts`) — for diagnostics and non-WS catch-up.

### 5. Catch-up after reconnect

When a tab reconnects it sends the cursor it last saw (`lastVersion`). The server calls `liveRelay.catchUp(socket, lastVersion, projectId)` (`websocket-server.ts:139`).

- **If no cursor** (fresh page load — the tab has already fetched HTTP truth): nothing to replay.
- **If a cursor is present:** the server pages through `listLiveEventsAfter(after, projectId, includeGlobal:true)` and sends each frame directly to that socket. (`live-relay.ts:142`)
- **If the cursor predates the pruned floor** (the outbox trims old rows on a timer): the server sends a `{ type: 'live-reset' }` frame instead. The browser drops all its cached state and refetches fresh data from HTTP.

The outbox is a delivery buffer, not permanent storage — it is pruned by both a max row count and a max age, whichever triggers first. (`index.ts:802`) Per-entity cursor positions are saved in `localStorage` under `pc.live.cursor.<scope>` so they survive page reloads. (`hooks.ts`)

### 6. The client-side live store — what the browser holds

`useLiveStore` is a single in-memory store (Zustand) in the browser. Key per entry: `${entity}::${entityId}`. It holds only the **latest** version-deduplicated `LiveEvent` per entity — not a history.

`applyEnvelope(env)`: validates the frame is a `LiveEventFrame`, then merges. Merge rule: if the incoming event's numeric `version` is not strictly greater than the stored one, it's a duplicate and is dropped. Entities with `version: null` always apply (last-write-wins). `seedEvents([])` does the same dedup logic for cold-load HTTP snapshots (e.g. `GET /api/agent-host/health` seeds the host health entity). `clearAll()` wires to `live-reset` — drops everything so stale frames can't be re-merged over freshly reloaded HTTP truth.

Components subscribe via `useLiveEvents(entity, projectId)` or `useLiveGlobalEvents(entity)` — memoized selectors off the store.

---

## How it connects

- **Depends on:** `@pc/db` (`live_outbox` table, `insertLiveEvent`, `listLiveOutboxRowsAfter`, `listLiveEventsAfter`, `getLiveEventHighWater`, `pruneLiveOutbox`) · `@pc/contracts` (`buildLiveEventFrame`, `LiveEvent`, `LiveEventFrame`, `LiveEventSubscribe`, `LiveEventResetFrame` — the wire shapes) · `ProjectWebSocketHub` (in-memory fanout) · mutation gateways (write side, one per domain).
- **Used by:** every service that announces a durable change (agent-run, work-item, workflow-run/review, workflow-definition, stage, field-schema, pod, area, contract, attachment, mailbox, host-health, session-title) · the WS connection handler · the React UI (`useLiveStore`, `useLiveEvents`, `useLiveWorkItems`, etc.).
- **Contracts / events crossed:** `LiveEventFrame` · `LiveEventSubscribe` · `LiveEventResetFrame` · `live_outbox` table · `LiveEventEntity` union (17 known entity types — must stay in sync between `@pc/db` and `@pc/contracts`).

---

## Target shape (per north star + Foundation Decisions)

**North-star §7:** "Push to the live UI: one relay tailing the event log."

**Ledger verdict:** `KEEP` (high confidence). The relay is already the one fanout. The dual-delivery migration (015a/015b) is explicitly in flight; the legacy hand-fanout paths are being deleted domain by domain.

**What changes in the target:**

- **015b (in flight):** delete all remaining direct `broadcastTo()` hand-fanout calls domain by domain until the relay is the sole live-delivery path. Agent-run changes are already fully relay-delivered (`agent-run-writer.ts:36` is a no-op `/* relay-delivered; no hand fanout */`). Remaining: orchestrator snapshots, JSONL streaming events.
- **Drain timing:** the blanket 250ms `setInterval` drain should become an explicit post-commit `relay.drain()` call at each gateway's commit site (the `015b` comment names this). Cuts the up-to-250ms lag on terminal transitions.
- **Workflow run events:** `appendEvent` writes to `workflow_run_events` but bypass the `live_outbox` gateway and the UI discards them (ledger §0, row 3). Ledger plan item 12: route `appendEvent` through the gateway so workflow events become first-class live facts.

> ☠ **The channel notification system is sentenced — FD-3 (locked 2026-06-03):** the per-orchestrator channel child, the `--dangerously-load-development-channels` flag + regex auto-confirm, channel MCP push notifications, the `channel-event` direct-to-UI broadcast, and inbound external webhook ingestion are ALL removed in the rebuild — **no piece survives.** The mailbox is the one notify door. See demolition map below.

---

## ☠ SENTENCED (FD-3): The Channel Server — demolition map

> **No piece of this survives the rebuild** (`_Foundation-Decisions.md` FD-3, locked 2026-06-03) — not the inbound webhook door ("no outside hooks at all"), not the per-CC child, not the dev-channels flag, not the `channel-event` broadcast. The mailbox is the one notify door. The as-built description below exists so the demolition is complete — every part listed here gets removed, none rebuilt.

`apps/server/src/services/channel-server.ts` listens on port 8788 (one multiplexed HTTP + WS listener for the whole server). Its two jobs:

1. **Inbound webhook entry:** `POST /channel/:slug/:source` — looks up the project by slug, validates the optional `X-Sender` header, routes the body to the durable mailbox (`webhookSink`), and also calls `onEvent` which does `broadcastTo(projectId, { type: 'channel-event', ... })`. This is a direct WS broadcast, **not** the live-outbox relay path.
2. **Per-CC bridge registration:** `WS /channel-register?projectId=...&sessionId=...&slug=...`. Each running Claude process spawns `channel-server/server.js` as an MCP child (via `.mcp.json`). That child connects WS-upstream to `/channel-register`, receiving forwarded channel events as `{ type: 'channel-event' }` messages, then emits them to the parent `claude.exe` via `notifications/claude/channel` MCP notifications (`channel-server/server.js:74`).

The channel server is the **inbound external-event** door for the orchestrator's webhook MCP channel. It is separate from and orthogonal to the live-events relay (which is the **outbound UI push** path). A webhook event is durably written to the mailbox by `webhookSink`; the mailbox then drives a separate `mailbox-message.changed` live-outbox row that the relay fans to the UI.

**Everything above is the demolition checklist. Remove all of it; rebuild none of it.**

---

## Known issues / scar tissue

- **Dual delivery still live for some domains.** Orchestrator snapshots and JSONL streaming events still use direct `broadcastTo()` alongside the relay. The client dedupes, but two code paths doing the same job violates "one path only." 015b is the migration; it is not done.
- **250ms polling lag.** The relay tails the outbox on a fixed interval, not on commit. A state change (e.g. run → completed) may take up to 250ms to reach the browser after the DB write. Not a correctness bug; noticeable in fast automated tests and on-screen transitions.
- **`live-reset` clears the entire client store.** `clearAll()` drops ALL entity snapshots, not just the affected scope or project. After a reset the UI is momentarily stale for every entity until the HTTP refetch completes. Acceptable for the rare "cursor predates pruning floor" case; heavier than needed if reset is used more deliberately.
- **`host-health` needs a special cold-load seed endpoint.** `listLiveEventsAfter` without a cursor returns nothing, so `host-health` requires a dedicated `GET /api/agent-host/health` snapshot call at page load (`client.ts:27`). Every other entity cold-loads from its own HTTP endpoint — consistent pattern, but must be remembered when adding new global last-write-wins entities.
- **Channel-event goes through direct broadcast, not the relay.** `channel-server.ts:88` calls `onEvent → broadcastTo(projectId, { type: 'channel-event', ... })` directly. This envelope is NOT a `LiveEventFrame`; the live store ignores it. The durable mailbox row (written by `webhookSink`) DOES produce a `mailbox-message.changed` relay row — but the raw channel-event itself bypasses the relay. *(☠ Moot under FD-3: this doesn't get fixed — it gets deleted with the rest of the channel system.)*

---

## Decisions & open questions

**For Emerson (product calls):**
- None blocking. The relay is keep-as-is in the rebuild; the only user-visible change is the eventual deletion of the channel system (FD-3 already locked).

**Technical:**
- When does 015b finish? Worth auditing remaining `broadcastTo()` call sites to enumerate dual-path domains and create a tracked deletion list.
- Should the blanket polling drain become explicit post-commit drain calls (one per gateway) to cut the 250ms lag? Low priority for correctness, relevant for perceived responsiveness.
- `workflow_run_events`: route `appendEvent` through the gateway (ledger plan item 12) — is this a slice-3 prerequisite, or can it be done independently?
- Should `live-reset` clear only the affected scope/project rather than the entire client store, to reduce the visible blank-then-reload flash on reconnect?
