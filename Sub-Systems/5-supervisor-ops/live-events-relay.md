# Live Events & Relay

> **Role:** cross-cutting (Store write side → UI delivery)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `apps/server/src/services/live-relay.ts`,
> `apps/server/src/services/websocket-hub.ts`,
> `apps/server/src/services/channel-server.ts`,
> `packages/db/src/repos/live-outbox.ts`,
> `packages/contracts/src/live-events.ts`,
> `packages/app-services/src/agent-runs/run-gateway.ts`,
> `apps/server/src/features/live-events/routes.ts`,
> `apps/web/src/store/live-store.ts`,
> `apps/web/src/features/live/hooks.ts`,
> `channel-server/server.js`

## What it is (plain English)

Whenever something important changes in the app — an agent run's state flips, a work item moves,
a workflow advances — the server writes a small "fact" row into a database table called `live_outbox`
at the same time it makes the underlying change. Every 250ms, a background loop reads any new fact
rows and pushes them over WebSocket to every browser tab that's watching. The browser stores each
incoming fact in a single client-side map and every UI component reads from that map.

The **channel server** is a separate but related thing: it is the door through which an external
webhook (e.g. HAAS Alert) can POST a message into a project, and through which each running Claude
process registers to receive those inbound messages. It is NOT part of the live-events relay — it
is inbound external-event routing, not outbound UI push.

## What it's supposed to do (intent)

Own the single path from "a durable fact was written to the DB" to "every open browser tab sees
the change". The outbox pattern decouples the durable write from delivery: if no browser is
connected the row stays in the table until pruned and can be replayed on reconnect. The relay
never delivers a write that rolled back (it only reads committed rows).

## How it works today (as-built)

### Write side — the outbox pattern

1. A service that mutates something the UI cares about opens a DB transaction, writes its row,
   **and also calls `insertLiveEvent(tx, draft)`** (`packages/db/src/repos/live-outbox.ts:90`) inside
   the same transaction. The outbox row carries: `id` (ULID), a gapless `seq` integer (the cursor),
   `scope` (`'project'` or `'global'`), `projectId`, `type` (e.g. `'agent.run.changed'`), `entity`,
   `entityId`, `version` (the entity's rev for dedup), and a JSON `payload`.
2. The scope/projectId invariant is enforced at insert time: global events must have no projectId;
   project events must have one (`live-outbox.ts:298`).
3. Each domain goes through a **mutation gateway** that wraps the mutation + the outbox insert into
   one `getDb().transaction()` call. Pattern: `AgentRunMutationGateway` (`run-gateway.ts:71`),
   mirrored by `WorkItemMutationGateway`, `WorkflowRunMutationGateway`, etc. The gateway returns an
   `AgentRunChangedPublication` (the committed outbox row + the DTO) only after the transaction
   commits; a rollback emits nothing.
4. Simpler call sites (workflow-definition changes, field schema, stage, pod, etc.) call
   `insertLiveEvent(tx, draft)` directly inside their own transaction
   (e.g. `workflow-routes.ts:273`).

### Relay loop — `LiveRelay` (`live-relay.ts`)

- Instantiated once at server boot (`index.ts:223`): `const liveRelay = new LiveRelay({ hub: wsHub })`.
- `liveRelay.primeToHead()` is called immediately after: snapshots the current max `seq` as the
  starting cursor so the relay does not flood clients with historical rows on startup (`live-relay.ts:81`).
- A `setInterval` at **250ms** calls `liveRelay.drain()` unconditionally (`index.ts:793`). This is
  the sole clock that drives delivery; there is no per-event wake-up.
- `drain()` is re-entrant-safe: a second call arriving while a drain is running sets a `redrain`
  flag and schedules one more pass; it does not stack (`live-relay.ts:89`).
- `drainOnce()` reads the raw mixed-scope stream (`listLiveOutboxRowsAfter`) in batches of 500,
  advancing the in-memory `deliveredCursor` as it goes. For each row it calls `fan()`.
- `fan()` wraps the row in a `LiveEventFrame` (`{ type: 'live-event', event: ... }`) via
  `buildLiveEventFrame` and routes it: `global` scope → `hub.broadcastAll()`; `project` scope →
  `hub.broadcast(projectId, ...)` (`live-relay.ts:122`).
- **Critical rule (documented in both `live-relay.ts:12` and `index.ts:222`):** `drain()` must
  never be called inside a `db.transaction()` closure. The rows it reads are only guaranteed
  committed after the transaction returns.

### WebSocket hub — `ProjectWebSocketHub` (`websocket-hub.ts`)

- A `Map<projectId, Set<socket>>`. Multiple browser tabs for the same project all subscribe; a
  reload race must not detach the surviving tab (`websocket-hub.ts:13`).
- `subscribe(projectId, socket)` returns an unsubscribe function; called on WS `close`.
- `broadcast(projectId, msg)` serialises `msg` to JSON, tags it with `projectId`, and sends to
  every OPEN socket for that project. Prunes dead sockets (not `OPEN`) as it goes.
- `broadcastAll(msg)` iterates every project's set and sends to all OPEN sockets.
- A 30-second keepalive sweep (`websocket-server.ts:157`) pings each client and terminates any
  that haven't ponged since the last pass, so half-open sockets (NAT timeout, laptop sleep) are
  reaped rather than silently absorbing broadcasts.

### WS connection + subscribe handshake

- WS connections land at `/ws?projectId=<id>&intent=chat` on the main API port (:4040 dev /
  :4060 packaged). `registerRuntimeHostWebSocketServer` (`websocket-server.ts:187`) creates the
  `WebSocketServer` on the shared HTTP server, subscribes the socket to the hub, and dispatches
  messages to `handleRuntimeHostWsMessage`.
- On every (re)connect, the browser sends `{ type: 'subscribe', lastVersion?: string, projectId? }`
  (`contracts/src/live-events.ts:98`). The server calls `liveRelay.catchUp(socket, lastVersion,
  projectId)` (`websocket-server.ts:139`).
- `catchUp()` (`live-relay.ts:142`): if no `lastVersion` (cold load — client just fetched HTTP
  truth), nothing to replay. Otherwise, it pages `listLiveEventsAfter(after, projectId,
  includeGlobal:true)` and sends each frame directly to that socket. If the cursor predates the
  pruned floor, it sends a `{ type: 'live-reset' }` frame instead so the client drops its stale
  cursor and refetches HTTP truth.

### HTTP replay route

- `GET /api/live-events?after=<cursor>&projectId=<id>&includeGlobal=1&limit=<n>`
  (`features/live-events/routes.ts`). Returns the same pageable window as the WS handshake.
  Primarily used for diagnostics / catch-up for non-WS consumers.

### Outbox pruning

- A second `setInterval` (`index.ts:802`) prunes the outbox by both a **max row count** and a
  **max age** (whichever hits first). The outbox is a delivery buffer, not a permanent store.
- A reconnecting client whose cursor predates the new floor hits `resetRequired: true` on
  `listLiveEventsAfter` (`live-outbox.ts:135`) and the relay sends `live-reset`.

### Client-side live store (`apps/web/src/store/live-store.ts`)

- A single Zustand store, `useLiveStore`. Key: `${entity}::${entityId}`. Holds only the latest
  version-deduped `LiveEvent` per entity id.
- `applyEnvelope(env)`: validates the envelope is a `LiveEventFrame`, calls `mergeEvent()`. Merging
  checks: if the new event's numeric `version` is not strictly greater than the stored one, it is a
  duplicate and is dropped. Entities with `version: null` (last-write-wins) always apply.
- `seedEvents(events[])`: same dedup logic, for the cold-load HTTP snapshot path (e.g. host-health
  seed via `GET /api/agent-host/health`).
- `clearAll()`: wired to `live-reset`; drops everything so stale frames cannot re-merge over
  freshly reloaded HTTP truth.
- Per-entity cursor positions are stored in `localStorage` under `pc.live.cursor.<scope>` (`hooks.ts`).
  The WS subscribe handshake sends the stored cursor as `lastVersion`.
- Views subscribe via `useLiveEvents(entity, projectId)` or `useLiveGlobalEvents(entity)` —
  memoized selectors off the Zustand map.

### Dual-delivery (015a transition state)

The relay currently ships **beside** a legacy hand-fanout on some subsystems. The client dedupes
by `id` + `version` so a row delivered twice is harmless. Comment `index.ts:219`:
> "015b deletes the legacy fanout subsystem-by-subsystem as the relay proves it."
Agent-run changes are already fully relay-delivered: `fanoutAgentRunChange` in `agent-run-writer.ts:36`
is a no-op (`/* relay-delivered; no hand fanout */`). Other domains (channel-event, orchestrator
snapshots, JSONL streaming events) still use direct `broadcastTo()` alongside the relay.

### The channel server — what it is and what it is NOT

`apps/server/src/services/channel-server.ts` listens on port 8788 (one multiplexed HTTP + WS
listener for the whole server). Its two jobs:

1. **Inbound webhook entry**: `POST /channel/:slug/:source` — looks up the project by slug,
   validates the optional `X-Sender` header, routes the body unconditionally to the durable mailbox
   (`webhookSink`), and also calls `onEvent` which does `broadcastTo(projectId, { type:
   'channel-event', ... })`. This is a direct WS broadcast, **not** the live-outbox relay path.
2. **Per-CC bridge registration**: `WS /channel-register?projectId=...&sessionId=...&slug=...`.
   Each running Claude process spawns `channel-server/server.js` as an MCP child (via `.mcp.json`).
   That child connects WS-upstream to `/channel-register`, receiving forwarded channel events as
   `{ type: 'channel-event' }` messages. It then emits them to the parent `claude.exe` via
   `notifications/claude/channel` MCP notifications (`channel-server/server.js:74`).

The channel server is the **inbound external-event** door for the orchestrator's webhook MCP
channel. It is separate from and orthogonal to the live-events relay (which is the **outbound
UI push** path). A webhook event is durably written to the mailbox by `webhookSink`; the mailbox
then drives a separate `mailbox-message.changed` live-outbox row that the relay fans to the UI.

## Integrations (how it connects)

- **Depends on:**
  - `@pc/db`: `live_outbox` table, `insertLiveEvent`, `listLiveOutboxRowsAfter`,
    `listLiveEventsAfter`, `getLiveEventHighWater`, `pruneLiveOutbox`.
  - `@pc/contracts`: `buildLiveEventFrame`, `LiveEvent`, `LiveEventFrame`, `LiveEventSubscribe`,
    `LiveEventResetFrame` — the wire shapes.
  - `ProjectWebSocketHub` — the in-memory fanout primitive.
  - Mutation gateways (per domain) — the write side.
- **Used by:**
  - Every service that announces a durable change (agent-run, work-item, workflow-run/review,
    workflow-definition, stage, field-schema, pod, area, contract, attachment, mailbox, host-health,
    session-title) — all write through `insertLiveEvent` or a gateway.
  - The WS connection handler — subscribes sockets to `wsHub`, calls `catchUp` on subscribe.
  - The React UI — `useLiveStore`, `useLiveEvents`, `useLiveWorkItems`, etc.
- **Contracts / events crossed:**
  - `LiveEventFrame` (`{ type: 'live-event', event: LiveEvent }`) — the canonical WS wire frame.
  - `LiveEventSubscribe` — client → server handshake.
  - `LiveEventResetFrame` — server → client gap signal.
  - `live_outbox` table — the durable write buffer.
  - `LiveEventEntity` union — the 17 known entity types (matches between `@pc/db` and
    `@pc/contracts`; these must stay in sync).

## Target shape (per north star)

**North-star §7:** "Push to the live UI: one relay tailing the event log."

**Ledger verdict:** `KEEP` (HIGH confidence). The relay is already the one fanout. The dual-delivery
transition (015a/015b) is explicitly in-flight; the legacy hand-fanout paths are being deleted domain
by domain. No merge/delete needed for the relay itself.

**What changes in the target:**

- The blanket 250ms polling timer (`setInterval` drain) should become an **explicit post-commit
  `relay.drain()` call** at each gateway's commit site (the 015b comment says this). Today, even
  after 015b, the polling timer handles draining — it just does so with up to 250ms lag. For most
  use cases this is fine; for low-latency feel on terminal transitions it could be tightened.
- The outbox is currently a delivery buffer, not the append-only event log that §2 calls the
  "source of truth". The **workflow engine's `appendEvent`** writes to `workflow_run_events` but
  those rows bypass the live_outbox gateway and the UI discards them (ledger §0, row 3). Ledger
  plan item 12: route `appendEvent` through the gateway so workflow events become truth too.
- Once all legacy `broadcastTo()` hand-fanout is deleted (015b complete), the relay is the sole
  live delivery path as the north star requires.

## Known issues / scar tissue

- **Dual delivery still live for some domains.** `channel-event`, orchestrator snapshots, JSONL
  streaming events still use direct `broadcastTo()` alongside the relay. The client dedupes, but
  two code paths doing the same job violates "one path only". 015b is the migration; it is not done.
- **250ms polling lag.** The relay tails the outbox on a fixed interval, not on-commit. A state
  transition (e.g. run → completed) may take up to 250ms to reach the UI after the DB commit.
  Not a correctness bug; noticeable in fast automated tests and on-screen transitions.
- **`live-reset` clears the entire client store.** `clearAll()` drops ALL entity snapshots, not
  just the affected scope. After a reset the UI is momentarily stale for every entity until the
  HTTP refetch completes. For a pruning gap (rare) this is acceptable; for a deliberate reset
  path it may be heavier than needed.
- **Global `host-health` needs a special cold-load seed endpoint.** Because `listLiveEventsAfter`
  without a cursor returns nothing, the `host-health` entity requires a dedicated
  `GET /api/agent-host/health` snapshot call at page load (`client.ts:27`). Every other entity
  cold-loads from its own HTTP endpoint; this is a consistent pattern but must be remembered when
  adding new global last-write-wins entities.
- **Channel-event goes through direct broadcast, not the relay.** When a webhook fires,
  `channel-server.ts:88` calls `onEvent → broadcastTo(projectId, { type: 'channel-event', ... })`
  directly. This envelope is NOT a `LiveEventFrame`; the live store ignores it. It goes to the
  existing legacy WS listeners only. The durable mailbox row (written by `webhookSink`) DOES
  produce a `mailbox-message.changed` live-outbox row that the relay fans to the UI — but the raw
  channel-event itself bypasses the relay. This is an inconsistency.

## Open questions

- When does 015b finish? Which domains still carry legacy hand-fanout alongside relay delivery?
  Worth auditing `broadcastTo()` call sites to enumerate remaining dual-path sites and create a
  tracked deletion list.
- Should the blanket polling drain become explicit post-commit drain calls (one per gateway) to
  cut the 250ms lag? Low priority for correctness, relevant for perceived responsiveness.
- `workflow_run_events` table: `appendEvent` writes exist but bypass the outbox (ledger §0). Is
  routing them through the gateway (ledger plan item 12) a slice-3 prerequisite, or can it be
  done independently?
- Should `live-reset` clear only the affected scope/project rather than the entire client store?
  Scoped clear would reduce the visible blank-then-reload flash on reconnect.
