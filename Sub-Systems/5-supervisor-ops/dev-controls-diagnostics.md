# Dev Controls & Diagnostics

> **Role:** cross-cutting (dev-only escape hatch + always-on observability)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `apps/server/src/diagnostics.ts` · `apps/server/src/features/dev-controls/routes.ts` · `apps/server/src/features/dev-controls/constants.ts` · `apps/web/src/components/DevControls.tsx` · `apps/web/src/features/dev-controls/client.ts` · `apps/server/src/services/process-control.ts` · `apps/server/src/services/terminal-mode.ts` · `apps/server/src/services/legacy-runtime-cleanup.ts` · `apps/server/src/services/host-health-writer.ts` · `apps/web/src/features/system/HostHealthPill.tsx` · `apps/web/src/features/system/HostHealthBanner.tsx` · `apps/web/src/features/system/host-health-banner-view.ts` · `apps/server/scripts/dev-supervisor.mjs` · `scripts/restart-stack.ps1`

---

## What it is (plain English)

A collection of developer escape hatches and always-on health monitoring. During development, a small panel in the bottom-right corner of the app lets you restart the backend or reload the page without leaving the browser. Separately, crash capture runs at all times and writes diagnostic files whenever the server dies — so the reason for a crash outlives the terminal window. A health pill and banner (visible in all builds, not just dev) show whether the agent-host process is reachable; if it isn't, the UI says so loudly because a dead host means no agents can run.

---

## What it's supposed to do (intent)

Four separate jobs, one file group:

1. **Dev panel** — one-click safe restart (with a guard if agents are active) plus debug toggles. Only present in `pnpm dev`; stripped from production builds automatically.
2. **Crash diagnostics** — capture the reason a server crash happened in files that survive past the terminal. Motivated by a real lost crash (exit 0xC0000374 heap corruption) that left no trace.
3. **Host-health surface** — show whether the agent host (the Engine process — the component that actually runs Claude agents) is connected, in every build mode.
4. **Shared utilities** — cross-platform "is this PID alive?" and "kill this process tree" helpers; raw PTY input forwarding; boot-time cleanup of old config files PC left in project folders.

---

## The parts (every component, plain English)

### 1. The dev panel

A small floating panel rendered only during `pnpm dev` — Vite strips it from packaged builds. It lives in the bottom-right corner of the shell (`Shell.tsx:174`).

**What it does:**

- **Status check** — polls `/api/dev/status` every 3 seconds (faster — 800ms — while reconnecting) and reports how many agents are currently running.
- **Restart** — sends `POST /api/dev/restart`. If agents are live and you haven't confirmed, the first click arms a "⚠ force?" warning; the second click sends the force flag. The panel then transitions through `restarting → reconnecting → idle` so you can see it come back.
- **Reload** — `window.location.reload()`. Refreshes the frontend without touching the server.
- **"canon" toggle** — switches the chat renderer to JSONL-canonical mode. Takes effect on the next reload; stored in `localStorage`.
- **"reveal" toggle** — shows chat rows that are normally hidden by policy. Also `localStorage`-backed, takes effect on reload.

The dev-only gate (`constants.ts:10`) is `PC_ROOT` env var absent. Packaged Electron sets `PC_ROOT`; dev runs do not. Routes are registered only when this is true (`routes.ts:14`).

---

### 2. The restart endpoint — and how it relates to the supervisor and restart-stack script

These are three different levels of "restart." They are not interchangeable.

| Level | What it does | When to use it |
|---|---|---|
| `POST /api/dev/restart` | Tells the running server to shut down cleanly and exit with code 75 (the sentinel). The supervisor sees 75 and respawns only the API/tsx child. Vite and the agent host keep running. | Picking up server-side code changes during a dev session. |
| `dev-supervisor.mjs` | Spawns the agent-host and API/tsx children; watches for exits. Exit 75 → respawn API with backoff. Any other exit → auto-recover up to 3 times if the server had been healthy for ≥30s; give up on rapid boot failures. Waits up to 12s for ports 4040/8788 to free before respawning. (`dev-supervisor.mjs:79`, `dev-supervisor.mjs:94`) | Runs automatically in the background; you don't call it directly. |
| `scripts/restart-stack.ps1` | Full stack restart (Windows). Kills the entire `dev-app.mjs` coordinator tree via `taskkill /T`, frees ports 4040/5173/8788, kills repo Electron and agent host, waits for ports to free, relaunches `pnpm dev:app` detached, then polls until server + Vite + host are all up. This is what the `restart-stack` skill runs. | Full teardown and relaunch — the only sanctioned full restart per `AGENTS.md`. |

**Exit code 75** is the sentinel (`constants.ts:2`): the API exits with 75 to say "I want to be restarted, not counted as a crash." The supervisor sees this and respawns cleanly. Any other exit code is treated as a crash.

**`gracefulShutdown()`** (`index.ts:1220`) is what actually cleans up before the exit: clears sweep intervals, sends WebSocket close frames (1001 "going away"), closes the WSS, closes the host connection, and shuts down all project runtimes. *(☠ channel-server shutdown removed by FD-3.)*

---

### 3. Crash diagnostics (the flight recorder)

`diagnostics.ts` is imported **first** in `index.ts:1` — before anything else — so it catches even errors that happen during boot.

**What it captures:**

- **Native diagnostic reports** — Node's built-in crash reporter writes a JSON file on fatal error or uncaught exception. Contains heap stats, UV handles (open sockets/files), and loaded shared libraries. Goes to `<dataDir>/diagnostics/report.*.json`.
- **Crash log** — a human-readable `<dataDir>/diagnostics/server-crashes.log` with one line per fatal event.
- **PTY lifecycle log** — `<dataDir>/diagnostics/pty-lifecycle.log`, written by the runtime layer (which can't import `@pc/utils` directly; the diagnostics module sets `process.env.PC_DIAG_DIR` so the runtime knows where to write).

`uncaughtException` and `unhandledRejection` handlers write to the log, trigger the native report, and then exit(1) — not 75, so the supervisor counts it as a crash and applies its recovery budget.

---

### 4. Process-control helpers

`process-control.ts` — two utilities used by liveness sweeps and force-kill paths across the codebase:

- **`isProcessAlive(pid)`** — probes the PID with `process.kill(pid, 0)` (a zero-signal probe that checks existence without actually sending a signal). `ESRCH` = dead; `EPERM` = alive but no permission; any other result = assume alive. Conservative by design: it never misreports a live agent run as dead.
- **`killProcessTree(pid)`** — on Windows, uses `taskkill /PID /T /F` to kill the process and all its children (including `claude.exe`'s own children). On POSIX uses `SIGKILL`. Fire-and-forget; the caller finalizes the DB row regardless of whether the kill succeeded.

---

### 5. Terminal-mode utilities

`terminal-mode.ts` — used by the orchestrator terminal-surface routes:

- **`validateTerminalInputData` / `forwardTerminalInput`** — validates raw PTY input (must be a string, 64KB max) then calls `runtime.ptySession().writeRaw()`. Returns a typed result: `ok | invalid-message | no-session | write-failed`.
- **`readTerminalTranscriptTail`** — reads a tail of `<sessionRoot>/transcript.log` (max 1MB). Uses path-containment checks (`isContained` with `path.relative` + `..` + `isAbsolute` guard) to prevent directory-escape attacks. Returns `{ bytes, truncated, mtimeMs }` or an empty string when the transcript doesn't exist yet — treated as "nothing to show" rather than a 404 to avoid console spam.

---

### 6. Legacy config cleanup (boot-time)

`legacy-runtime-cleanup.ts` — runs on every server boot (`index.ts:287`).

**The problem it solves:** Old PC versions wrote `.mcp.json`, `.claude/settings.json`, `.claude/hooks/*.cjs`, and `.claude/agents/*.md` directly into user project folders. When a user opens a terminal in one of those folders, `claude.exe` auto-discovers those files and picks up PC's old config — which leaks into unrelated terminal sessions.

**What it does:** Iterates all projects (including deleted ones). For each, backs up the original file to `<dataDir>/projects/<id>/legacy-claude-runtime/<timestamp>/` before touching it. Then:
- Rewrites `.mcp.json` — strips PC entries (`mcp__pc-rig__`, `webhook` entries), keeps user entries.
- Rewrites `.claude/settings.json` — strips PC-owned keys (`PC_SESSION_ID`, `statusLine` hook, PC hook entries, `permissions` block), keeps user keys.
- Deletes the six named PC hook `.cjs` files and PC-authored `.claude/agents/*.md` files.
- Removes empty directories left behind.

Idempotent — already-clean projects are skipped cheaply.

---

### 7. The host-health indicator (pill + banner)

The "agent host" is the Engine process — the separate process that actually runs Claude agents. If it's down, agents can't be dispatched.

**How the health signal flows:**

1. `hostConnection.onHealthChange` fires whenever the host connection changes state.
2. `host-health-writer.ts` calls `announceHostHealth(snapshot)`, writing a `host-health.changed` event to the `live_outbox` table with a stable entity ID (`'host-health'`).
3. The live-relay drain fans that row to all connected WebSocket clients.
4. A seed endpoint (`GET /api/live-events/global/host-health`, `index.ts:997`) returns the latest stored frame so a fresh page load can populate the indicator without waiting for the next health change.

**The two UI pieces (always-on — present in dev and packaged builds):**

- **`HostHealthPill`** — a small colored chip in the app header (`App.tsx:419`). Green/amber/red dot + label. Shows the host PID and host ID on hover when connected.
- **`HostHealthBanner`** — a loud strip below the header (`App.tsx:442`). Only renders when `state !== 'connected'`. Messages: "Agent host unreachable — agents can't be dispatched" (down) or "Reconnecting to agent host…" (reconnecting). The render decision is extracted to `host-health-banner-view.ts` so it can be unit-tested without a DOM.

---

## How it connects

- **Depends on:** `ActiveRunRegistry` (active-run count for the restart guard) · `@pc/db` / `insertLiveEvent` (host-health writes) · `live-relay` drain sweep (fans `live_outbox` rows to WebSocket clients) · `hostConnection` (`host-connection.ts`, emits health-change events) · `gracefulShutdown()` in `index.ts` (called by the restart endpoint before exit(75)).
- **Used by:** `Shell.tsx` (mounts dev panel, dev-only) · `App.tsx` (mounts pill and banner, always) · liveness sweep and force-kill paths (`isProcessAlive` / `killProcessTree`) · orchestrator terminal-surface routes (`forwardTerminalInput` / `readTerminalTranscriptTail`) · `dev-supervisor.mjs` (receives the exit(75) sentinel).
- **Contracts / events crossed:** `live_outbox` table → `host-health.changed` global events · `HostHealthSnapshot` type (`@pc/contracts`) · `DevStatus` type (`features/dev-controls/types.ts`, `{ activeAgents, canRestart }`) · exit code 75 (restart sentinel between API process and supervisor).

---

## Target shape (per north star + Foundation Decisions)

Per `unified-process-supervision-2026-06-02.md` §9 Step 7 and ledger §0:

- **Dev supervisor** (`dev-supervisor.mjs`) and the packaged Electron host-spawner (`desktop/agent-host-process.ts`) are both `KEEP → fold into Supervisor` (HIGH confidence). Step 7 is the near-term anchor: unify them into one `@pc/supervisor` package used identically in dev and packaged builds. This closes the "packaged host never respawns" gap.
- Once the Supervisor lands, the restart endpoint's role may shift: today it signals a dev-only sentinel exit to `dev-supervisor.mjs`. In the target the Supervisor is the one process manager in both modes; the restart mechanism may stay (as a "request graceful restart" signal to the Supervisor) or be internalized. The dev-only `!process.env.PC_ROOT` guard may become unnecessary.
- **Diagnostics, process-control, terminal-mode, and legacy-runtime-cleanup** have no consolidation verdict — they're cross-cutting utilities or one-time boot operations. They stay as-is.
- **Host-health surface** is already on the target path: one authoritative health event from the Engine, one relay to the UI. No structural change needed.

---

## Known issues / scar tissue

- **Packaged host never respawns.** `dev-supervisor.mjs` respawns the host on crash in dev. The packaged Electron build spawns the host once and does not respawn it. Step 7 Supervisor explicitly closes this gap. (Ledger §0 and §6 row 4.)
- **Restart endpoint only restarts the API.** `POST /api/dev/restart` exits the API/tsx child; the agent host keeps running (or may have already died). After a sentinel restart the server reconnects to the existing host; a stale or wrong-endpoint host needs Step 3 (Engine re-resolution) to recover. Today that reconnect is brittle.
- **Exit-75 backoff.** Rapid sentinel restarts (server dies in <5s) accumulate a capped delay up to 8s. A tsx compile error that loops can add noticeable lag to each restart attempt. (`dev-supervisor.mjs:94`)
- **Port-free wait.** The supervisor waits up to 12s for ports 4040/8788 to free before respawning. On Windows a process can hold a socket briefly after exit; restarting via the endpoint may appear "hung" for several seconds. (`dev-supervisor.mjs:79`)
- **Terminal-transcript path-escape** — `isContained` uses `path.relative` correctly (guards `..` and absolute paths). This was a prior scar (`reference_startswith_path_containment.md`); the fix is in place.
- **Legacy cleanup runs every boot.** Scans all projects including deleted ones. Low risk today; could be gated behind a version stamp if it becomes a bottleneck on large installs.
- **Dev-panel renderer toggles are `localStorage`-backed.** A browser cache clear silently resets them to default with no visible indicator unless the panel is opened and checked.

---

## Decisions & open questions

**For Emerson (product calls):**
- None here — this subsystem is infrastructure. The one user-visible question is whether the host-health indicator is prominent enough when the host is down. The banner is deliberately loud, but this is worth confirming in a real incident.

**Technical:**
- When Step 7 Supervisor lands: should `POST /api/dev/restart` route through the Supervisor (signal it to gracefully restart the Brain/API child) rather than the API self-exiting? The self-exit approach works but inverts the supervision contract slightly.
- Does the Supervisor need its own health/status endpoint (analogous to `/api/dev/status`) so the dev panel can show Supervisor state, not just API state?
- Should legacy-runtime-cleanup run only once and record a version stamp, or continue every boot? The current every-boot approach is safe but wasteful for clean installs.
- `readTerminalTranscriptTail` will become obsolete once the Engine owns all PTY sessions (Steps 4–5) and transcripts are read via the unified tailer path. Is there a plan to route the orchestrator terminal surface through the same mechanism?
