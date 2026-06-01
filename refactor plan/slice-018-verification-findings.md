# Slice 018 — verification findings + console-error log (2026-06-01)

Live verification of slice 018 (client live-event store) on the running gated stack
(server pid 19792 / Vite 26240), driven via Playwright against Vite (5173), probes
in the scratch "Quick Tasks" project, cleaned up after. NO server restart (changes
are client-only → Vite HMR).

## A. What PASSED live (no reload, settled build = 0 console errors)

| Check | Path exercised | Result |
|---|---|---|
| Create work item (API) → Kanban | live store (`useLiveWorkItems`) | ✅ live |
| Same item → Table view | NEW `useResourceList` derive (seed + store overlay) | ✅ live |
| Rename (version v1→v2) → Table | version-overlay branch | ✅ live |
| Soft-delete → Table | dropOnTerminal branch; persisted across reload | ✅ live |
| Areas filter-rail counts | (work-item-derived) | ✅ live (0→1→0) |
| Cold reload (production-like bundle) | full app | ✅ 0 console errors; create still live |

Structural note: `useResourceList` no longer reads the chat-timeline `events` array
at all — it derives from the identity-keyed store. There is no positional cursor left
to fall out of sync, so the old staleness failure mode is gone by construction. The
committed spike already proved the exact session-rebuild case on Kanban.

## B. Active-session test — PASSED (after a server restart re-discovered the host)

Dispatched a `writer` agent via `POST …/agents/writer/invoke` (host reachable after the
restart). All live, no reload:
- **agent-run appeared live as "running"** in the Running agents panel (the NEW
  `useResourceList` agent-run path) during the active session.
- **work-item (probe C) appeared live in the Table WHILE the agent ran** (work-item
  `useResourceList` under the active-agent condition — the exact case that used to go
  stale).
- **agent-run dropped live on terminal**: the writer wouldn't self-complete a trivial
  one-word task (still "running" at ~90s, rev=3 — the known host-dispatch idle issue,
  separate from slice 018), so it was `/cancel`-led → terminal → it disappeared from
  Running agents live (dropOnTerminal branch).

**VERDICT: slice 018 live-verified.** Both `useResourceList` entities (agent-run +
work-item) propagate live during an active agent session; the old positional-cursor
staleness is gone.

## C. Console-error enumeration (the "don't just ignore" pass)

Captured via `browser_console_messages level=error all=true` across the whole session.

### C1. REAL — log for fixing
1. **`GET /api/live-events?after=…` → 500 — server-BOOT-window transient.**
   - Reproduced TWICE, both in the ~1s window right after a server (re)start, when the
     client's reconnect fires the catch-up request at a not-yet-ready server. Once boot
     settled it returns 200 (`after=208`→200, `after=1`→200 `resetRequired`). `/api/dev/status`
     500'd in the same window and also cleared. Route `live-events/routes.ts:38` returns
     500 for any non-`LiveEventCursorError` from `listLiveEventsAfter`.
   - **Impact: low** — boot-window only; the client's reconnect epoch-bump full-reload
     fires anyway, so the UI is not left stale. **Fix rec:** during boot, return 503
     (retryable) rather than 500, or have the client treat a catch-up 5xx as "retry after
     backoff". Priority: low.
2. **Server does NOT re-discover the agent host after the host restarts → permanent
   "host-unavailable" until the SERVER restarts.**
   - Host was healthy this session (pid 8308, `http://127.0.0.1:55117/health` → 200,
     lock `data/agent-host/host.lock.json`), but `POST …/agents/:name/invoke` returned
     `{ok:false, cause:"host-unavailable", error:"…start-run failed: fetch failed"}`.
     The host restarted at 09:34 onto a new port after the server booted; the server's
     cached `AgentHostReattachClient` baseUrl is stale and never re-resolved from the
     lock file.
   - **Impact: HIGH for agent dispatch** (blocks ALL agent/workflow runs until a server
     restart). Relates to the known out-of-process-host L4/L5 holes.
   - **Fix rec:** on a host fetch failure, re-read `discoverAgentHostEndpoint(dataDir)`
     and retry against the current lock (or watch the lock file for port changes).
     Priority: HIGH (separate from slice 018).

### C2. NOT REAL — Vite HMR edit-time transients (ignore; will not occur for users)
All tagged with `?t=<ts>` module versions + `@react-refresh` / `scheduleRefresh` /
`performReactRefresh` stack frames = artifacts of saving source files mid-session while
the app was hot-reloading. A clean cold reload showed 0 of these. They are NOT bugs and
require no fix; logged only so they are not mistaken for real:
- `ReferenceError: useRef is not defined` (use-project-areas) — saved after removing the import.
- `ReferenceError: useLiveWorkItems is not defined` (KanbanBoard) — live-store mid-edit.
- `React detected a change in the order of Hooks` (KanbanBoard, ActivityPanel) — hooks added/removed across a refresh.
- `Rendered more hooks than during the previous render` (KanbanBoard) — same.
- `TypeError: Cannot read properties of null (reading 'getSnapshot')` (zustand useStore via useStatuslineSync / useResourceList) — store module hot-swapped.

## D. Agent host blocker (why the live-agent test couldn't run)
Host process healthy + reachable directly; dev server can't reach it (stale cached
endpoint, C1#2). To run the live-agent test, the **server** must re-discover the host —
a server restart (e.g. the dev "restart" control / `POST /api/dev/restart`) does this on
boot, but disrupts the running stack + any in-flight work → user's call, not done unasked.

## E. UI surfaces NOT yet on the live store (deferred from slice 018, still on the old scan)
1. **Rich-link previews** — `use-rich-link-invalidator` (per-id cache eviction).
2. **Inbox / "Waiting on you" mailbox** — `scanMailboxLiveEvents` (3 entities:
   mailbox-message, mailbox-delivery, pending-interaction; mailbox-delivery isn't even in
   the `LiveEventEntity` union; plus global-scope inbox). Notable: mailbox live-update has
   been flaky historically — strongest candidate to migrate next.
3. **Session titles** — `SessionsRail`.

Intentionally NEVER on the store (separate live streams, by design): chat transcript,
raw terminal output, statusline/usage telemetry, send-queue status.

Plan **step 4** (pull live-events OFF the chat timeline + delete the
`chat-session-reducer` retention) stays blocked until E1–E3 migrate and the active-agent
repro passes.
