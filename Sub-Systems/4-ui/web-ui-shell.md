# Web UI Shell

> **Role:** UI
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `apps/web/src/App.tsx`, `apps/web/src/components/Shell.tsx`, `apps/web/src/components/LeftRail.tsx`, `apps/web/src/components/Tabs.tsx`, `apps/web/src/store/`, `apps/web/src/hooks/use-project-ws.ts`, `apps/web/src/store/live-store.ts`, `apps/web/src/hooks/use-resource-list.ts`, `apps/web/src/api/client.ts`

## What it is (plain English)

The React frontend — a browser page (served by Vite in dev, Electron renderer in packaged) that shows projects, chat, work items, agents, and workflows. It holds no durable state of its own: all real data lives in the Brain's SQLite database. The UI subscribes to a WebSocket stream from the Brain, projects that stream into visual components, and calls HTTP APIs for mutations.

## What it's supposed to do (intent)

Pure view + input. Receive live facts from the Brain, render them, and let the user issue commands. The UI must be safe to kill and reload at any moment — it reattaches to the same Brain and reconstructs its full visual state from the data stream.

## How it works today (as-built)

### Boot sequence

1. `apps/web/src/main.tsx` mounts `<App>` inside `React.StrictMode`.
2. `App.tsx` (cold load):
   - Fetches `projectsApi.listProjects()` and `settingsApi.getSettings()` over HTTP.
   - Reads persisted active-project slug from `useActiveProject` (Zustand, localStorage).
   - Renders the onboarding wizard full-screen if `onboardingCompletedAt === null` and no projects exist; otherwise renders the full shell.
3. Once projects load, `Shell.tsx` mounts the three-panel layout.

### Shell layout

`Shell.tsx` uses `react-resizable-panels` in a horizontal group:

| Panel | Fixed width | Component |
|---|---|---|
| Left rail | 192 px (fixed) | `LeftRail` |
| Center | 70% (resizable, min 30%) | `Center` (tab-switched) |
| Activity panel | 192 px, collapsible to 36 px | `ActivityPanel` |

The 32 px header is rendered in `App.tsx` (not Shell), with: brand menu → breadcrumb (project › tab · session) → host-health pill → model name → activity-panel toggle.

### Left rail

`LeftRail.tsx` is a mode switch:
- `centerTab === 'files'` → renders `FilesRail` unconditionally (overrides mode).
- `railMode === 'sessions'` → renders `SessionsRail` (persistent orchestrator session list).
- Default → `ProjectRail` (the main project list with drag-reorder, right-click menu, unread dots).

Rail mode persisted in `useRailMode` (Zustand, localStorage, `pc.rail-mode`). Coerces a stale `'files'` value back to `'projects'` on migration.

### Tab bar

`Tabs.tsx` defines `TABS = ['orchestrator','work-items','agents','workflows','files']` plus `'project-settings'` (gear icon, right-aligned). Tab labels are display names only (`'orchestrator'` → `'chat'`). Active tab persisted in `useActiveCenterTab` (Zustand, `pc.center-tab`; global, not per-project — switching projects keeps you on the same tab).

`Center` in `Shell.tsx` is a plain conditional render: `tab === 'work-items'` → `<WorkItemsPage>`, etc. No lazy loading.

### Status bar

`StatusBar.tsx` lives in the Orchestrator panel footer. Shows:
- MCP pill (poll via `settingsApi.getMcpStatus` every 5 s).
- Runtime health pill (from `runtimeSnapshot.health` or `runtimeHealth` prop).
- WS status pill.

Model and token usage moved to the App header via `useOrchestratorTelemetry`.

### Feature-folder structure

Each domain has a `features/<name>/` folder under `apps/web/src/features/`:

```
agent-runs/     agents/     areas/      chat/
contracts/      dev-controls/  files/   live/
mailbox/        project-context/  projects/  runtime/
settings/       system/     transient-sessions/
workflows/      work-items/
```

Each folder typically contains `client.ts` (typed HTTP calls + types for that domain) and feature-specific components or hooks. `apps/web/src/api/client.ts` re-exports everything and assembles a single `api` object for convenience.

### WebSocket subscription

`useProjectWs` (`apps/web/src/hooks/use-project-ws.ts`) is the primary WS hook:

- Connects to `/ws?projectId=<id>&intent=chat`. The `intent=chat` param tells the Brain to spawn/attach the orchestrator for this socket.
- Exponential backoff on reconnect (2 → 5 → 15 → 30 s cap, `RECONNECT_SCHEDULE_MS`).
- Sends a heartbeat ping every interval; force-reconnects if `lastInboundAt` is stale (`heartbeatTimedOut`).
- On `(re)open`: bumps `useWsEpoch` for the project (triggers resource-list refetches) and sends a `subscribe` handshake with the stored `lastVersion` cursor so the relay replays missed events.
- Message routing in the `ws.message` handler:
  - `live-event` frames → fed into `useLiveStore.applyEnvelope(env)` then `return` (never reach the chat reducer).
  - `live-reset` (cursor below floor) → `clearLiveCursor` + `useLiveStore.clearAll()` + epoch bump.
  - `session-replay` envelope → resets `seenTs` dedup set, replayed into `chatSessionReducer`.
  - All other chat/runtime envelopes → `chatSessionReducer` via `dispatchRuntimeEnvelope` (raw frames are 50 ms micro-batched before dispatch).
- `useAllProjectsWs` opens one background socket per non-active project for cross-project unread detection and live-store updates.

### Identity-keyed live store

`apps/web/src/store/live-store.ts` is the single client-side live-event store (Slice 018):

- Zustand store; key = `${entity}::${entityId}`.
- `applyEnvelope` applies one WS live-event frame with per-entity version dedup (numeric version; null → last-write-wins).
- `seedEvents` cold-loads HTTP snapshots with the same dedup (used for host-health on boot).
- `clearAll` wired to `live-reset` frames.
- Selectors: `useLiveEvents(entity, projectId)` (project-scoped + global), `useLiveGlobalEvents`, `useLiveEntitySignature` (stable string; flip-only on genuine change), `useLiveGlobalSignature`, `useLiveWorkItems`.

**Why it exists:** legacy per-view index-cursor scans off the chat timeline (`events[n]`) fell out of sync when the timeline re-derived during active sessions (session-replay/snapshot shifted indices). Identity + version keying is rebuild-proof.

### Resource-list pattern

`apps/web/src/hooks/use-resource-list.ts` (`useResourceList`) provides the standard two-source pattern for any resource list (agent runs, workflows, pods, etc.):

1. **HTTP seed** — fetched on mount, project switch, and WS epoch bump (reconnect). Stored as `Map<id, T>`.
2. **Live overlay** — `useLiveEvents` from the identity store, applied by id on top of the seed. `dropOnTerminal` removes completed records (the seed endpoint also excludes them).

The `_events: WsEnvelope[]` parameter is retained for signature compatibility but is no longer read (comment in code: "Records come from the live store, not this array.").

### Client state stores (Zustand)

All stores are in `apps/web/src/store/`:

| Store | Persisted? | Purpose |
|---|---|---|
| `useActiveProject` | yes (`pc.active-project`) | Active project slug |
| `useActiveCenterTab` | yes (`pc.center-tab`) | Current center tab |
| `useRailMode` | yes (`pc.rail-mode`) | Rail mode (projects/sessions) |
| `useLiveStore` | no | Identity-keyed live event map |
| `useWsEpoch` | no | Per-project WS reconnect counter |
| `useOrchestratorTelemetry` | no | Model, usage, session id, CC state |
| `useAgentTranscript` | no | Which agent-run transcript is open |
| `useMcpPanel` | no | MCP tool panel open/closed |
| `useAppSettingsModal` | no | App settings modal open/closed |
| `useStatuslineStore` | no | Orchestrator statusline data |
| `useRichLinkPreview` | no | Rich link preview card |
| `useViewingSession` | (unverified) | Which historical session is in read-only view |
| others (chat-scroll-target, attachment-lightbox, chat-work-item-modal, etc.) | no | Single-purpose modal/scroll signals |

### API client

`apps/web/src/api/client.ts` re-exports and assembles typed API slices from every feature folder's `client.ts`. No central HTTP wrapper — each feature client uses `fetch` directly. Mutations are fire-and-optimistic-update where appropriate (e.g. project reorder in `App.tsx:280`).

### Theming

`apps/web/src/index.css` — Vellum theme. Key constraint:

```css
--radius-xs: 0; --radius-sm: 0; --radius-md: 0; --radius-lg: 0;
--radius-xl: 0; --radius-2xl: 0; --radius-3xl: 0;
--radius-full: 9999px;
```

Every Tailwind `rounded-*` class except `rounded-full` renders as square corners. Do not use border-radius as a visual differentiator. Font: JetBrains Mono throughout (`--font-ui` = `--font-mono`). Palette: warm parchment on charcoal, tan/gold primary (`#d4a64a`), no dark-mode variants.

Font scale is a CSS custom property (`--font-scale`) set on `documentElement` from `settings.fontScale`; `AppSettingsModal` previews it live.

## Integrations (how it connects)

- **Depends on:**
  - Brain (HTTP API + WebSocket at `/ws?projectId=&intent=chat`).
  - `@pc/contracts` package for shared envelope types (`isLiveEventFrame`, `LiveEventEntity`, etc.).
- **Used by:** the end user (browser / Electron renderer). No other subsystem calls into the UI.
- **Contracts / events crossed:**
  - Inbound WS: `WsEnvelope` union (live-event, live-reset, session-changed, session-replay, raw, event, runtime-state, send-ack, send-queue-snapshot, server-pong). Defined in `apps/web/src/features/runtime/ws-types.ts`.
  - Outbound WS: `WsOutbound` (subscribe handshake, heartbeat ping, chat send). Typed in the same file.
  - HTTP: feature-scoped typed clients (projects, runtime, settings, work-items, workflows, agent-runs, agents, files, transient-sessions, live-events, settings/mcp).

## Target shape (per north star)

North star (`unified-process-supervision-2026-06-02.md` §2): **UI shell = pure view + input, owns nothing, reattaches to the Brain**.

The current shell is already very close to this role:
- Holds no durable state (all truth is in the Brain's SQLite).
- Reattaches cleanly on reload — the WS subscribe handshake with cursor catch-up reconstructs live state; the HTTP seed fills the gap.
- The identity-keyed live store (`live-store.ts`, Slice 018) already implements the "projection of server facts" model.

**Ledger verdict:** no explicit KEEP/MERGE/DELETE verdict in `consolidation-ledger-2026-06-02.md` for the UI shell as a whole — it is not a consolidation target. The ledger only touches the UI indirectly (e.g. `WorkflowsList.tsx:871` discards `res.events`, flagged as dead observability writes until Slice-3 routes `workflow_run_events` through the live relay).

**What changes toward the target:**
- When Slice-3 routes `appendEvent` through `live_outbox` → relay, the UI will receive workflow-run events through the existing live-store path with no UI-side change needed.
- Steps 4–5 (orchestrator + modals migrating to the Engine) are server-side; the UI consumes them through the same WS envelopes — no structural UI change unless the envelope shapes change.
- The `_events: WsEnvelope[]` parameter on `useResourceList` (kept for signature compatibility) can be removed once all callers are confirmed to use only the live store.

## Known issues / scar tissue

- **`useResourceList` `_events` param retained but dead** (`use-resource-list.ts:57`): passed everywhere for signature stability. The old positional-cursor scan that read it was replaced by the live-store overlay. Safe to remove once confirmed no callers still rely on it.

- **WS envelope must scan the live store, not the last element** (memory note `useresourcelist_scan_all_envelopes`): the pre-Slice-018 pattern keyed off a positional index into `events[]`. React batches WS messages; terminal envelopes buried under non-matching ones were silently dropped. Slice 018 fixed this by moving to the identity-keyed store. Do not reintroduce positional scanning.

- **Dual-stream render identity for chat** (memory note `pc_pty_dual_stream_render_identity`): hook + JSONL dedup — the surviving JSONL envelope must inherit the hook's `idx` via a `replacedBy` map. Keying off the JSONL's own `idx` causes remount flicker ("chat eaten up"). Relevant to `apps/web/src/features/chat/`. Cross-ref: chat subsystem doc.

- **React 18 StrictMode double-invoke** (`main.tsx:9`): `StrictMode` is active. Cleanup functions in `useEffect` that POST stop/cancel/destroy will fire ~50 ms after mount in dev, destroying the resource before the user does anything. Confirmed burned once on a spawn-race diagnosis. Move teardowns to explicit user-action handlers.

- **Popover dismiss trap** (memory note `react_popover_dismiss_trap`): a popover opened from `onContextMenu`/`onClick` can be dismissed by its own opening event when the dismiss listener attaches in the same `useEffect` state-change cycle. Fix: `e.stopPropagation()` on the opener. Confirmed in `ProjectRail`-area context menus.

- **`live-event` frames never reach chat reducer** (`use-project-ws.ts:339`): the `return` after `applyEnvelope` is load-bearing. Removing it would double-route live-event frames into the chat reducer.

- **`WorkflowsList.tsx:871` discards `res.events`** (ledger §2, sources of truth): `appendEvent` writes `workflow_run_events` but the UI discards them. Until Slice-3 routes those through the live relay, they are dead observability writes that never reach the UI.

- **MCP status is polled, not pushed** (`StatusBar.tsx:171`): `settingsApi.getMcpStatus` fires every 5 s. No WS-driven path exists for it.

- **Vellum theme zeroes all border-radii** (`index.css:63–70`): every `rounded-*` utility is 0 except `rounded-full`. Any component relying on rounded corners for visual differentiation will render as square. Not a bug but a trap for new components.

- **Session title in header uses `sessionLabel` from `useOrchestratorTelemetry`**: published by the Orchestrator component; null until the first chat event lands, so the header breadcrumb is blank on fresh spawn.

## Open questions

- Should the `_events: WsEnvelope[]` parameter be formally removed from `useResourceList` and all its callers now that Slice 018 is stable, or deferred until a broader cleanup pass?
- When Slice-3 lands (`appendEvent` through live relay), do workflow-run live events need a new `LiveEventEntity` value, or do they reuse an existing one?
- The `live-event` path in `use-project-ws.ts` returns early after `applyEnvelope` — does the background `useAllProjectsWs` similarly short-circuit, or do background sockets still push live-events through a chat reducer? (Needs verification in `use-all-projects-ws.ts`.)
- `useViewingSession` persistence behavior (localStorage vs session): not verified.
