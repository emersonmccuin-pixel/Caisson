# Web UI Shell

> **Role:** UI
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `apps/web/src/App.tsx` · `components/Shell.tsx` · `components/LeftRail.tsx` · `components/Tabs.tsx` · `store/` · `hooks/use-project-ws.ts` · `store/live-store.ts` · `hooks/use-resource-list.ts` · `api/client.ts` · `index.css`

---

## What it is (plain English)

The screen is a pure window onto the server — nothing more. Everything you see (cards, chats, agents, workflows) lives in the server's database. The screen only borrows a copy. Close the browser tab and reopen it: nothing is lost, nothing is stale. The screen reconnects, asks what it missed, and catches up.

---

## What it's supposed to do (intent)

Show you what the server knows, let you act on it, and stay perfectly in sync no matter how many times you close or reload it. One law: **the screen owns no durable state.** It may cache things in memory for speed, but the server's database is always the truth.

---

## The parts (every component, plain English)

### 1. First boot — what happens before anything is on screen

When the app loads (`main.tsx`, `App.tsx`):

1. Asks the server for the project list and your settings over HTTP.
2. Remembers which project you last had open (stored in browser local storage via a Zustand store — a tiny library that saves app state).
3. If you've never set up the app (`onboardingCompletedAt` is empty and no projects exist), shows the onboarding wizard full-screen.
4. Otherwise: mounts the full shell.

> ⚠️ `React.StrictMode` is active (`main.tsx:9`) — a React developer mode that intentionally mounts and unmounts every component twice in quick succession. Any cleanup code that sends a "cancel" or "stop" to the server will fire ~50 ms after mount and destroy the resource before the user has done anything. Teardowns must be tied to explicit user actions, not `useEffect` cleanup. Confirmed burned once.

---

### 2. The shell layout — what you see on screen

Three panels side by side (`Shell.tsx`, using `react-resizable-panels`):

| Panel | Width | What it does |
|---|---|---|
| Left rail | 192 px, fixed | Navigation: projects, sessions, or files |
| Center | 70 % of remaining width, resizable | The active tab's content |
| Activity panel | 192 px, collapses to 36 px | Background activity and notifications |

A 32 px header bar sits above all three (`App.tsx`). It holds: the brand menu, a breadcrumb showing "project › tab · session", a host-health pill, the model name, and the activity-panel toggle.

---

### 3. The left rail — how you navigate

`LeftRail.tsx` switches between three modes:

- **Files mode** — if the Files tab is active, the rail always shows `FilesRail` (overrides everything else).
- **Sessions mode** (`railMode === 'sessions'`) — shows the list of past orchestrator sessions.
- **Default** — shows `ProjectRail`: the list of your projects with drag-to-reorder, right-click menus, and unread-message dots.

Which mode you were last in is remembered across reloads (Zustand, localStorage key `pc.rail-mode`). A stale `'files'` value gets automatically corrected to `'projects'` on migration.

---

### 4. The tab bar — the five areas of the app

`Tabs.tsx` defines five tabs: `orchestrator` (shown as "Chat"), `work-items`, `agents`, `workflows`, `files`, plus a gear icon (project settings) pinned to the right.

The active tab is remembered globally across reloads (Zustand, `pc.center-tab`). Switching projects does **not** reset the tab — you stay on whichever tab you were on.

`Shell.tsx`'s center panel is a plain `if/else` render — whichever tab is active, that component shows; no lazy loading.

---

### 5. How live updates flow to the screen (the WebSocket)

`useProjectWs` (`hooks/use-project-ws.ts`) is the live connection to the server. Think of it as a constant open phone line — the server talks to you the moment anything changes.

**Connection details:**
- Connects to `/ws?projectId=<id>&intent=chat`. The `intent=chat` part tells the server to attach the orchestrator (your AI assistant) to this connection.
- If the connection drops, it retries with growing gaps: 2 s → 5 s → 15 s → 30 s max.
- Sends a heartbeat ping on a timer; force-reconnects if it hasn't heard back within the timeout window.

**What happens when (re)connected:**
- Bumps a reconnect counter (the "WS epoch") that triggers all resource lists to re-fetch their HTTP seed.
- Sends a `subscribe` handshake carrying the last version number it processed, so the server replays anything it missed.

**What happens with incoming messages:**
- `live-event` frames → go into the live store (§6 below), then stop. They never reach the chat display.
- `live-reset` (server told the client its cursor is too old) → wipes the live store and re-fetches.
- `session-replay` → replays the chat history into the chat display.
- Everything else (chat messages, runtime state, etc.) → micro-batched 50 ms then dispatched to the chat display.

**Background connections:** `useAllProjectsWs` opens one extra background socket per non-active project just to track unread dots and keep the live store warm for those projects.

---

### 6. The client-side live store — the screen's memory of server facts

`store/live-store.ts` (Zustand) is a single in-memory map of the latest known state for every entity (work items, agent runs, workflow runs, etc.).

- **Key:** `entity::entityId` — one slot per thing.
- **Update rule:** each incoming live-event carries a version number; an older version never overwrites a newer one. No version number → last-write-wins.
- **On reconnect:** wiped on `live-reset`, refilled from the HTTP seed + incoming events.
- **Selectors available:** by project, globally, by entity, or as a "signature" string that changes only when the underlying data actually changes (useful for avoiding unnecessary re-renders).

**Why it exists:** the old approach tracked live updates by position in the chat timeline array (`events[n]`). When the timeline shifted (session-replay, snapshot), the indices broke and updates went missing. Keying by identity and version is rebuild-proof.

---

### 7. The resource-list pattern — how any list stays up to date

`hooks/use-resource-list.ts` (`useResourceList`) is the standard recipe every list in the app follows (agent runs, workflows, pods, etc.):

1. **HTTP seed** — on mount, on project switch, and on reconnect, fetch the current list from the server and store it as an in-memory map keyed by id.
2. **Live overlay** — layer live-store updates on top by id. If an item finishes (`dropOnTerminal`), remove it from the list (the seed endpoint also excludes finished items, so they don't re-appear on reconnect).

The `_events: WsEnvelope[]` parameter still exists in the function signature for compatibility, but is no longer read. All updates come through the live store now.

---

### 8. The client-side stores — what the screen remembers locally

All Zustand stores live under `apps/web/src/store/`:

| Store | Survives reload? | What it holds |
|---|---|---|
| `useActiveProject` | yes (`pc.active-project`) | Which project you have open |
| `useActiveCenterTab` | yes (`pc.center-tab`) | Which tab is active |
| `useRailMode` | yes (`pc.rail-mode`) | Left-rail mode (projects / sessions) |
| `useLiveStore` | no | The live-event map (§6) |
| `useWsEpoch` | no | Reconnect counter per project |
| `useOrchestratorTelemetry` | no | Model name, token usage, session id, CC state |
| `useAgentTranscript` | no | Which agent-run transcript is expanded |
| `useMcpPanel` | no | Tool panel open/closed |
| `useAppSettingsModal` | no | App settings modal open/closed |
| `useStatuslineStore` | no | Orchestrator status-line data |
| `useRichLinkPreview` | no | Rich link preview card |
| `useViewingSession` | (unverified) | Which past session is in read-only view |
| others (scroll-target, attachment-lightbox, chat work-item modal…) | no | Single-purpose UI signals |

---

### 9. The API client — how the screen talks back to the server

`apps/web/src/api/client.ts` assembles one `api` object from every feature folder's own `client.ts`. Each feature client uses `fetch` directly — there is no shared HTTP wrapper. Mutations can be optimistic (e.g. project reorder updates the screen immediately before the server confirms, `App.tsx:280`).

Feature folders under `apps/web/src/features/`:

```
agent-runs/   agents/         areas/           chat/
contracts/    dev-controls/   files/           live/
mailbox/      project-context/ projects/       runtime/
settings/     system/         transient-sessions/
workflows/    work-items/
```

Each folder typically has a `client.ts` (typed HTTP calls + types for that domain) plus feature-specific components and hooks.

---

### 10. Theming — the visual rules the screen follows

`apps/web/src/index.css` — the Vellum theme.

**The zero-radii constraint (a real trap):** every Tailwind `rounded-*` CSS class except `rounded-full` is overridden to 0. There are no rounded corners anywhere in the app. Any new component that uses `rounded-sm`, `rounded-lg`, etc. as a visual cue will render as a hard square. Only `rounded-full` (circles/pills) works as expected. (`index.css:63–70`)

Other theme facts:
- Font: JetBrains Mono throughout (`--font-ui = --font-mono`).
- Palette: warm parchment on charcoal, tan/gold accent (`#d4a64a`), no dark-mode variants.
- Font scale: a CSS variable (`--font-scale`) set on the document root from `settings.fontScale`; the settings modal previews it live.

---

### 11. The status bar

`StatusBar.tsx` lives in the orchestrator panel footer. Shows three pills:

- **MCP** — polled from `settingsApi.getMcpStatus` every 5 seconds. ⚠️ No server-push path for this; it's always slightly stale.
- **Runtime health** — from `runtimeSnapshot.health`.
- **WebSocket status** — connection state.

Model name and token usage moved out of the status bar into the main header via `useOrchestratorTelemetry`.

---

## How it connects

- **Depends on:** the Brain (HTTP API + WebSocket at `/ws`) · `@pc/contracts` package (shared WS envelope types: `isLiveEventFrame`, `LiveEventEntity`, etc.).
- **Used by:** the end user (browser or Electron renderer). No other subsystem calls into the UI.
- **Inbound WS envelope types:** `live-event`, `live-reset`, `session-changed`, `session-replay`, `raw`, `event`, `runtime-state`, `send-ack`, `send-queue-snapshot`, `server-pong` — all defined in `features/runtime/ws-types.ts`.
- **Outbound WS types:** `subscribe` handshake, heartbeat ping, chat send — same file.
- **HTTP:** feature-scoped typed clients (projects, runtime, settings, work-items, workflows, agent-runs, agents, files, transient-sessions, live-events, settings/mcp).

---

## Target shape (per north star + Foundation Decisions)

The north star (`unified-process-supervision-2026-06-02.md §2`) says the UI shell should be a pure view + input layer that owns nothing and reattaches cleanly. **The shell is already very close:**

- No durable state — all truth is in the Brain's SQLite.
- Reconnects cleanly — the `subscribe` handshake with a version cursor replays missed events; the HTTP seed fills the snapshot gap.
- The identity-keyed live store already implements the "projection of server facts" model.

**No consolidation verdict** exists in the ledger for the UI shell as a whole — it is not a consolidation target. The ledger touches it only indirectly.

**What still changes toward the target:**

- ~~**Slice-3 (workflow-run events)**~~ ✅ M3a (2026-06-04): diary lines ride `live_outbox` → relay as `workflow.run.event`; the run panel's "Run diary" timeline consumes them via `useLiveEntitySignature('workflow-run-event')` → one refetch per genuine line.
- **Steps 4–5 (orchestrator + modals → Engine):** server-side moves; the UI consumes them through the same WS envelopes. No structural UI change unless envelope shapes change.
- **`_events` param cleanup:** the dead `_events: WsEnvelope[]` parameter on `useResourceList` can be removed once all callers are confirmed to use only the live store.

---

## Known issues / scar tissue

- **Rails must not be adjustable (Emerson, 2026-06-03 — open bug).** Left and right rails are meant to be fixed-width, but both still render resize-adjuster arrows, and the right-rail adjuster can actually collapse the rail. Fix: remove the adjuster affordances on both rails; kill the right-rail collapse behavior.

- ~~**`WorkflowsList.tsx` throws away `res.events`**~~ ✅ fixed in M3a — `RunInlineDetail` renders the events as the "Run diary" timeline with live updates.

- **`useResourceList` `_events` param is dead** (`use-resource-list.ts:57`) — still in every call signature for compatibility. The old positional-cursor scan it powered was replaced by the live-store overlay (Slice 018). Safe to remove once confirmed.

- **Do not re-introduce positional index scanning** — the old `events[n]` pattern broke silently when session-replay shifted the array. React batches WS messages; terminal envelopes buried under later items were dropped. Slice 018 fixed this with identity + version keying. The lesson is law.

- **React 18 StrictMode double-invoke** (`main.tsx:9`) — see §1 above. Any `useEffect` cleanup that POSTs a destructive action will fire twice in dev. Burned once on a spawn-race diagnosis.

- **Dual-stream chat render identity** — hook + JSONL dedup: the surviving JSONL envelope must inherit the hook's `idx` via a `replacedBy` map. Keying off the JSONL's own `idx` causes remount flicker ("chat eaten up"). (`features/chat/` — cross-ref the chat subsystem doc.)

- **Popover dismiss trap** — a popover opened from `onContextMenu` or `onClick` can be immediately dismissed by its own opening event when the dismiss listener attaches in the same `useEffect` cycle. Fix: `e.stopPropagation()` on the opening event handler. Confirmed in `ProjectRail` context menus.

- **`live-event` frames must not reach the chat reducer** (`use-project-ws.ts:339`) — the `return` after `applyEnvelope` is load-bearing. Removing it would double-route live events into the chat display.

- **MCP status is polled, not pushed** (`StatusBar.tsx:171`) — fires every 5 s; no WS-driven path exists. The pill is always slightly stale.

- **Session title is blank on fresh spawn** — the header breadcrumb reads `sessionLabel` from `useOrchestratorTelemetry`, which is null until the first chat event arrives.

- **Vellum zero-radii** — `index.css:63–70`. Covered in §10. Burned multiple design iterations.

---

## Decisions & open questions

**For Emerson (product calls):**

1. **Tab persistence across projects** — right now switching projects keeps you on the same tab (e.g. stay on Agents when you jump to a different project). Is that right, or should switching projects reset you to Chat?
2. **Background socket per project** — the app maintains a live connection for every project you have, not just the active one, so unread dots stay accurate. Is that the right tradeoff if you have many projects?

**Technical:**

- Should `_events: WsEnvelope[]` be formally removed from `useResourceList` and all callers now that Slice 018 is stable, or wait for a broader cleanup pass?
- When Slice-3 lands, do workflow-run live events need a new `LiveEventEntity` enum value, or do they reuse an existing one?
- Does `useAllProjectsWs` (background sockets) short-circuit on `live-event` frames the same way the primary socket does, or do background sockets still push live-events through the chat reducer? (Needs verification in `use-all-projects-ws.ts`.)
- `useViewingSession` persistence behavior (localStorage vs session): not verified.
