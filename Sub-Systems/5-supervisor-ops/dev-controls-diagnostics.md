# Dev Controls & Diagnostics

> **Role:** cross-cutting (dev-only escape hatch + always-on observability)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> - `apps/server/src/diagnostics.ts`
> - `apps/server/src/features/dev-controls/routes.ts`
> - `apps/server/src/features/dev-controls/constants.ts`
> - `apps/web/src/components/DevControls.tsx`
> - `apps/web/src/features/dev-controls/client.ts`
> - `apps/server/src/services/process-control.ts`
> - `apps/server/src/services/terminal-mode.ts`
> - `apps/server/src/services/legacy-runtime-cleanup.ts`
> - `apps/server/src/services/host-health-writer.ts`
> - `apps/web/src/features/system/HostHealthPill.tsx`
> - `apps/web/src/features/system/HostHealthBanner.tsx`
> - `apps/web/src/features/system/host-health-banner-view.ts`
> - `apps/server/scripts/dev-supervisor.mjs`
> - `scripts/restart-stack.ps1`

## What it is (plain English)

A thin layer of developer tools and crash-capture plumbing that sits on top of the real app. In dev mode only, a small panel in the bottom-right corner of the UI lets you restart the backend or reload the frontend without leaving the browser. Separately, always-on crash capture writes native diagnostic reports and log files when the server dies. A host-health pill and banner in the UI (visible in all modes) show whether the agent-host process is connected, reconnecting, or down.

## What it's supposed to do (intent)

- **Dev panel:** give one-click safe restart (with active-agent guard) + frontend reload, plus debug toggles for chat renderer behavior. Exists only during `pnpm dev`; Vite tree-shakes it from production bundles.
- **Crash diagnostics:** persist the reason a server crash happened so it survives past terminal scrollback. Motivated by a real lost native crash (exit 0xC0000374 heap corruption) that left no trace.
- **Host health surface:** expose whether the agent host (the Engine process) is reachable, in all modes. A degraded host means agents can't be dispatched; the UI must say so loudly.
- **Process-control helpers:** provide the single cross-platform definition of "is a PID alive" and "kill this process tree" — used by liveness sweeps and force-kill paths.
- **Terminal-mode utilities:** validate + forward raw PTY input; read a session's transcript tail off disk. Used by the orchestrator terminal surface routes.
- **Legacy runtime cleanup:** on every boot, scan all project folders and remove PC-owned Claude config files (`.mcp.json` pc-rig entries, `.claude/hooks/*.cjs`, `.claude/settings.json` PC blocks, `.claude/agents/*.md`) that were written by old PC versions into project roots. PC now passes session-local `--settings`/`--mcp-config`; leaving old root files pollutes terminal-launched Claude Code in those folders.

## How it works today (as-built)

### Dev controls

- **Guard:** `isDevControlsEnabled()` (`constants.ts:10`) returns `true` only when `PC_ROOT` env var is absent — the dev signal. Packaged Electron sets `PC_ROOT`; dev runs do not. Routes are registered only when this is true (`routes.ts:14`).
- **`GET /api/dev/status`** (`routes.ts:21`): returns `{ activeAgents, canRestart }` — counts live runs from `ActiveRunRegistry`.
- **`POST /api/dev/restart`** (`routes.ts:32`): reads optional `{ force: boolean }` body. If agents are live and `force` is false → 409. Otherwise schedules (50ms setTimeout) a call to `gracefulShutdown()` then `process.exit(75)`. Exit code 75 is the sentinel (`constants.ts:2`) that tells `dev-supervisor.mjs` to respawn a fresh tsx child rather than treat it as a crash.
- **`gracefulShutdown()`** (`index.ts:1220`): clears all sweep intervals, sends WebSocket close frames (1001 "going away"), closes the WSS, closes the host connection, shuts down all project runtimes and the channel server.
- **Frontend panel** (`DevControls.tsx`): rendered only under `import.meta.env.DEV` in `Shell.tsx:174`. Polls `/api/dev/status` every 3 seconds (800ms while reconnecting). On restart: shows active-agent count; if agents live and not yet force-armed, first click arms a `forceArmed` confirmation state showing "⚠ force?"; second click sends `force:true`. Transitions through `restarting → reconnecting → idle` phases. Also has "reload" (window.location.reload), "canon" toggle (JSONL-canonical chat renderer), and "reveal" toggle (reveal policy-hidden chat rows) — both backed by `localStorage` and take effect on reload.

### Restart relationship: endpoint vs supervisor vs restart-stack

These are three different levels:

1. **`POST /api/dev/restart`** — in-process: tells the running server to gracefully shut down and exit(75). The supervisor (`dev-supervisor.mjs`) sees exit 75 and respawns only the API/tsx child. Does NOT restart Vite, Electron, or the agent host. Used for picking up server-side code changes during dev.
2. **`dev-supervisor.mjs`** (`apps/server/scripts/dev-supervisor.mjs`): spawns both the agent-host child and the API/tsx child; watches for exits. Exit 75 → respawn API with backoff. Crash (non-75) → auto-recover up to `MAX_CRASH_RESTARTS=3` times if the server had been healthy for ≥30s; give up on rapid boot failures. Waits for ports 4040/8788 to free before respawning to avoid EADDRINUSE. Also respawns the host on crash with the same budget.
3. **`scripts/restart-stack.ps1`** — full stack restart (Windows only): kills the entire `dev-app.mjs` coordinator tree via `taskkill /T`, frees ports 4040/5173/8788, kills repo Electron + agent host, waits for ports to free, relaunches `pnpm dev:app` detached, then polls until server + Vite + host are all up. This is the `restart-stack` skill's target and the only sanctioned full restart per `AGENTS.md`.

The endpoint is for lightweight in-session restarts; `restart-stack` is for full teardown + relaunch.

### Crash diagnostics

- `diagnostics.ts` is imported **first** in `index.ts:1` before anything else, so fatal errors during boot are still captured.
- Sets `process.env.PC_DIAG_DIR` so the runtime (which doesn't import `@pc/utils`) can log PTY lifecycle events to the same directory.
- Configures `process.report` to write native Node diagnostic reports on fatal error + uncaught exception (heap, UV handles, loaded shared libs) to `<dataDir>/diagnostics/`.
- `uncaughtException` and `unhandledRejection` handlers: write to `server-crashes.log`, call `process.report.writeReport()`, then exit(1) (not 75, so the supervisor counts it as a crash, not a sentinel restart). Also writes to stderr so `dev-supervisor.mjs` log capture sees it.
- Output files: `diagnostics/report.*.json` (native report), `diagnostics/server-crashes.log` (one line per fatal), `diagnostics/pty-lifecycle.log` (written by the runtime).

### Process-control helpers

`process-control.ts`:
- `isProcessAlive(pid)`: uses `process.kill(pid, 0)` (no-signal probe). `ESRCH` = dead; `EPERM` = alive but no permission; anything else = assume alive (conservative — never misreport a live run as dead).
- `killProcessTree(pid)`: on Windows uses `taskkill /PID /T /F` (kills child tree including claude.exe's children); on POSIX uses `SIGKILL`. Fire-and-forget; caller finalizes the DB row regardless.

### Terminal-mode utilities

`terminal-mode.ts`:
- `validateTerminalInputData` / `forwardTerminalInput`: validates raw PTY input (must be string, ≤64KB), then calls `runtime.ptySession().writeRaw()`. Returns typed result (`ok | invalid-message | no-session | write-failed`).
- `readTerminalTranscriptTail`: reads a tail of `<sessionRoot>/transcript.log` (max 1MB). Uses path-containment checks (`isContained` with `path.relative` + `..` + `isAbsolute` guard) to prevent path-escape. Returns `{ bytes, truncated, mtimeMs }` or empty string when transcript doesn't exist yet (treats stale/replaced session ids as "nothing to show" rather than 404 to avoid console spam).

### Legacy runtime cleanup

`legacy-runtime-cleanup.ts`, called at every server boot (`index.ts:287`):
- What legacy it cleans: PC used to write `.mcp.json` (with `pc-rig`/`webhook` server entries), `.claude/settings.json` (PC-owned `permissions` block + `statusLine` hook + hook entries), `.claude/hooks/*.cjs` (six named PC hook files), and `.claude/agents/*.md` (PC-authored agent files) directly into user project roots.
- Why: `claude.exe` auto-discovers root-level `.mcp.json` and `.claude/` when a user opens a terminal in that folder — old PC entries leak into unrelated sessions.
- How: iterates all projects (including deleted). For each, backs up the original to `<dataDir>/projects/<id>/legacy-claude-runtime/<timestamp>/` before touching it. Rewrites `.mcp.json` (strips PC entries, keeps user entries), rewrites `.claude/settings.json` (strips PC-owned keys, keeps user keys), deletes PC hook files and agent files, removes empty dirs. Distinguishes PC-owned entries by signature strings (`PC_SESSION_ID`, `mcp__pc-rig__`, etc.) so user-owned Claude config is never touched.
- Run on every boot (idempotent). Already-clean projects are skipped cheaply.

### Host-health surface

- `host-health-writer.ts`: `announceHostHealth(snapshot)` writes a `host-health.changed` global `live_outbox` row with a stable constant entity ID (`'host-health'`). Called from `index.ts:280` whenever `hostConnection.onHealthChange` fires.
- UI reads the global live-event store slot keyed `'host-health'`.
- `HostHealthPill` (`features/system/HostHealthPill.tsx`): always-on small chip in the app header (App.tsx:419). Green/amber/red dot + label. Shows host PID + hostId on hover when connected.
- `HostHealthBanner` (`features/system/HostHealthBanner.tsx`): app-level loud strip below the header (App.tsx:442). Renders only when `state !== 'connected'`. Message: "Agent host unreachable — agents can't be dispatched" (down) or "Reconnecting to agent host…" (reconnecting). Pure render decision extracted to `host-health-banner-view.ts` for unit-testability without DOM.
- Seed endpoint (`index.ts:997`): `GET /api/live-events/global/host-health` returns the latest stored frame so a fresh page load can seed the pill without waiting for the next health change.

## Integrations (how it connects)

- **Depends on:**
  - `ActiveRunRegistry` (agent-active-runs) — active-run count for restart guard
  - `@pc/db` / `insertLiveEvent` — host-health writes to `live_outbox`
  - `live-relay` drain sweep — fans `live_outbox` rows to WebSocket clients (the pill/banner receive frames this way)
  - `hostConnection` (`host-connection.ts`) — emits health-change events that drive `announceHostHealth`
  - `gracefulShutdown()` (index.ts) — called by the restart endpoint before exit(75)
- **Used by:**
  - `Shell.tsx` — mounts `DevControls` (dev-only)
  - `App.tsx` — mounts `HostHealthPill` and `HostHealthBanner` (always)
  - Liveness sweep + force-kill paths — call `isProcessAlive` / `killProcessTree`
  - Orchestrator terminal-surface routes — call `forwardTerminalInput` / `readTerminalTranscriptTail`
  - `dev-supervisor.mjs` — receives the exit(75) sentinel and responds by respawning
- **Contracts / events crossed:**
  - `live_outbox` table — `host-health.changed` global events
  - `HostHealthSnapshot` type (`@pc/contracts`) — the typed payload crossing server → UI
  - `DevStatus` type (`features/dev-controls/types.ts`) — `{ activeAgents, canRestart }` over HTTP
  - Exit code 75 — the restart sentinel protocol between the API process and `dev-supervisor.mjs`

## Target shape (per north star)

Per `unified-process-supervision-2026-06-02.md` §9 Step 7 and ledger §0:

- **Dev supervisor** (`dev-supervisor.mjs`) and the packaged Electron host-spawner (`desktop/agent-host-process.ts`) are both `KEEP→fold into Supervisor` (HIGH confidence). Step 7 is the near-term anchor: unify them into one `@pc/supervisor` package used identically in dev and packaged builds.
- Once that lands, the restart endpoint's relationship changes: today it signals a dev-only sentinel exit to `dev-supervisor.mjs`. In the target the Supervisor is the one process manager in both modes; the restart mechanism may stay (as a "request graceful restart" signal to the Supervisor) or be internalized as the Supervisor's own health-check loop. The dev-only guard (`!process.env.PC_ROOT`) may become unnecessary if the Supervisor owns restart in both modes.
- **Diagnostics**, **process-control**, **terminal-mode**, and **legacy-runtime-cleanup** are not addressed in the migration steps — they are either cross-cutting utilities or one-time boot operations with no structural duplication. They stay as-is; no consolidation verdict.
- **Host-health surface** aligns with the target: the Engine emits one authoritative health event; one relay fans it to the UI. Already on that path. No structural change needed.
- `DevControls.tsx` (and its chat-renderer debug toggles) is dev scaffolding — dev-only by construction, no target-state change needed.

## Known issues / scar tissue

- **Packaged host never respawns.** The packaged Electron build spawns the agent host once but does NOT respawn it on crash (`dev-supervisor.mjs` does this in dev, but the Electron main.ts supervision path doesn't). This is the explicit gap that Step 7 Supervisor fixes. Noted in ledger §0 and §6 row 4.
- **Agent-host restart during `POST /api/dev/restart`:** the endpoint only restarts the API/tsx child. The agent host keeps running (or may have died). After a sentinel restart the server re-connects to the existing host; if the host is stale/wrong-endpoint, the Brain needs Step 3 (Engine re-resolution) to recover. Today the reconnect is brittle.
- **Exit-75 backoff:** rapid sentinel restarts (server dies in <5s) accumulate a capped delay (up to 8s). A thrashing tsxcompile error can add noticeable lag to each restart attempt (`dev-supervisor.mjs:94`).
- **Port-free wait on restart:** the supervisor waits up to 12s for ports 4040/8788 to free before respawning (`dev-supervisor.mjs:79`). If a previous process holds the socket briefly after exit (common on Windows), restarting via the endpoint can appear "hung" for several seconds.
- **Terminal-transcript path-escape guard:** the `isContained` helper uses `path.relative` correctly (guarding `..` and absolute) — this was a prior scar (`reference_startswith_path_containment.md`); the fix is in place.
- **Legacy cleanup is idempotent but runs every boot.** It scans all projects including deleted. On a large project list this adds a few ms of synchronous work at startup. Low risk; could be gated behind a version stamp if it ever becomes a bottleneck.
- **Chat-renderer toggles in DevControls** use `localStorage` and `window.location.reload()` — state persists across restarts but not across browser clears. If a session is started with the wrong renderer mode, a cache-clear silently resets to default without any visible indicator until the panel is checked.

## Open questions

- When Step 7 Supervisor lands: should `POST /api/dev/restart` route through the Supervisor (signal it to gracefully restart the Brain/API child) rather than the API self-exiting? The self-exit approach works but inverts the supervision contract slightly.
- Does the Supervisor need its own health/status endpoint (analogous to `/api/dev/status`) so the DevControls panel can show Supervisor state, not just API state?
- Should legacy-runtime-cleanup run only once and record a version stamp, or continue every boot? The current every-boot approach is safe but wasteful for clean installs.
- Terminal-mode's `readTerminalTranscriptTail` will become obsolete once the Engine owns all PTY sessions (Steps 4–5) and the transcript is read via the unified tailer path. Is there a plan to route the orchestrator terminal surface through the same mechanism?
