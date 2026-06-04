# Desktop / Electron Shell

> **Role:** UI (packaged wrapper) + interim Supervisor (packaged mode only)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `apps/desktop/src/main.ts` · `apps/desktop/src/agent-host-process.ts` · `apps/desktop/src/preload.ts` · `apps/desktop/src/port-conflict.ts` · `apps/desktop/package.json`

---

## What it is (plain English)

**The installed Windows app is one program currently doing three jobs at once: it is the window, the server host, and the parent of the agent host child process.** When a packaged user launches Caisson, that single EXE starts everything — it boots the API server inside itself, spawns the agent host as a child process, and opens the browser window, all in one.

The dev stack is completely different: window, server, and frontend are three separate programs that a supervisor script manages independently. That structural disagreement is the root cause of the biggest gap (the packaged host never respawns). Step 7 of the rebuild splits the jobs apart.

---

## What it's supposed to do (intent)

Turn Caisson into a self-contained Windows app — one installer, one EXE, no separate Node or server setup required. The shell starts everything a packaged user needs, handles port conflicts at launch, and delivers auto-updates from GitHub Releases.

---

## The parts (every component, plain English)

### 1. ONE runtime — no modes (Step 7, shipped 2026-06-04)

The shell boots exactly ONE way: Electron main is THE supervisor (`@pc/supervisor`). It spawns the
API and agent host as supervised child processes running the shipped bundles, opens the window from
one configured URL, and respawns either child on crash. There is no dev/packaged fork — anything
that could differ (entry paths, node binary, data dir, port, window URL) is an INPUT resolved once
in `resolveStackConfig()` (`main.ts`). Dev tooling (`scripts/dev-app.mjs`) feeds different inputs
(repo dist bundles, system node, Vite URL); the app can't tell. `PC_DESKTOP_DEV=1` only labels the
window (title/icon).

### 2. Boot sequence (both modes — identical)

1. **Port conflict check** — probes the API port. Caisson-owned offenders → "Free ports & retry"
   dialog (walks up to the dev-app coordinator / packaged app root and `taskkill /F /T`); others →
   Retry only; two failed rounds → error dialog → quit.
2. **`supervisor.start()`** — host child first (stale lock removed pre-spawn; fresh-mtime lock =
   ready gate), then the API child (port-free pre-spawn gate; sentinel-75 restart policy).
3. **Wait for the API to answer** (`waitForPortsBound`, 60 s) — the window only opens against a
   live API; a miss = loud error dialog, never a blank window.
4. **Open the window** at the configured URL (packaged: `http://127.0.0.1:PORT`; dev: Vite).

### 3. Crash handling — the never-respawns gap is CLOSED

Either child crashing → respawn with backoff (500 ms → 8 s), crash budget 3 rapid failures, healthy
30 s+ uptime resets the budget. Budget exhausted → loud "Caisson keeps crashing" dialog pointing at
`<dataDir>/diagnostics/children.log` → quit. ☠ `startInProcessServer` (in-process API import — an
API crash could take the window down) and the log-only host exit handler are DELETED; the
ONE-SUPERVISOR gate keeps them dead. Quit is one path: `before-quit` → `stopAndWait` (host gets the
polite HTTP `shutdown host-exit`; stragglers SIGKILLed at 5 s).

**Shutdown:** on app quit, `stopPackagedAgentHost()` sends a graceful HTTP shutdown request to the host, waits 2 seconds, then sends `SIGTERM` if it is still alive. (`main.ts:298–309`)

### 4. Lock file handshake

The only signal the main process has that the agent host is ready is a small JSON file the host writes to disk after it starts:

```
{ pid, hostId, port, startedAt, protocolVersion: 1 }
```

- Old lock file is deleted before spawn so there is no stale signal.
- Main polls for the file every 100 ms, up to 5 seconds. (`agent-host-process.ts`)

⚠️ **Drift twin risk:** the lock file shape is hand-copied inside `agent-host-process.ts:1–7` because importing the `@pc/runtime` package (which owns the real definition) would pull `node-pty` into the desktop bundle, causing an ABI conflict with Electron's Node version. If the lock file schema changes in `packages/runtime/src/agent-host-lock-file.ts` and this file is not updated by hand, the desktop shell will silently time out at boot and never open.

### 5. Preload bridge (what the window can do)

The preload script (`preload.ts`) is a thin layer — the only thing it hands to the browser window through `window.pcDesktop` is:

- `isDesktop: true` — so the UI knows it is running as the installed app.
- `platform` — the OS name.
- `updates` — check, download, install, and subscribe to update state.

The window talks to the API the normal way (HTTP/WS on `:4040`); there is no general Node bridge.

### 6. Auto-update

- Uses `electron-updater`, reading from the public GitHub Releases feed (`emersonmccuin-pixel/Caisson`). (`main.ts:31–33` in `package.json` build config)
- **User-driven:** `autoDownload: false` — the update is only downloaded when the user asks.
- **Installs on quit:** once downloaded, the update installs the next time the user closes the app (`autoInstallOnAppQuit: true`).
- **Disabled in dev mode:** update state stays `'unsupported'`.

Update state is owned by the main process and pushed to the window over IPC (`pc:update-state`). The window never touches the updater directly.

### 7. Electron 35 pin — why it is frozen

`"electron": "^35.0.0"` (`package.json:83`). Electron 35 ships with Node ~20.

Upgrading to Electron 42+ would use a newer V8/Node ABI (the low-level interface between native code and Node) that breaks `better-sqlite3 11.10.0`'s pre-built native database bindings. Rebuilding those bindings against the new ABI has not been validated. The pin stays frozen until that rebuild is confirmed safe.

### 8. Build and packaging

The `prepackage` script:
- Builds four bundles: main, web (Vite), server, agent-host (all via esbuild).
- Stages the pinned `claude.exe`, server resources, and rebuilt native modules under `staging/`.
- `@electron/rebuild` rebuilds native modules against Electron's ABI.

Output: an NSIS installer (`Caisson Setup.exe`) for Windows, plus DMG + ZIP for macOS. The macOS boot sequence (lock file, in-process server) has not been verified end-to-end. (unverified)

---

## How it connects

- **Depends on:** `@pc/server` (bundled API, imported in-process in packaged mode) · `@pc/agent-host` (spawned as child process) · `packages/runtime` lock file shape (via drift twin).
- **Used by:** end users (the packaged installer) · developers iterating on the Electron shell (DEV mode only).
- **Boundary contracts:**
  - Lock file (`agent-host/host.lock.json`) — the only boot handshake between main and the agent host.
  - IPC channels `pc:update-state`, `pc:update:get-state`, `pc:update:check`, `pc:update:download`, `pc:update:install` — between main process and window.
  - HTTP/WS on the API port — the window talks to the supervised API child the same way as the browser-based dev user.

---

## Target shape — ✅ SHIPPED 2026-06-04 (Step 7)

The earlier "supervisor outside Electron" sketch was superseded by the locked Step-7 scope: **Electron main IS the supervisor** (one decision, `supervisor-build-scope-2026-06-03.md`). As built:

- ☠ The in-process `import(serverEntry)` is deleted; the API is a supervised child always.
- ☠ `startPackagedAgentHost` / `spawnPackagedAgentHostProcess` are deleted; the host is a supervised child of the same list. `agent-host-process.ts` keeps only the lock-file helpers + the polite HTTP shutdown.
- Port-conflict handling stayed in the shell (UI-facing) and now runs on the one boot path, both modes.
- Full as-built detail: [supervisor.md](supervisor.md).

---

## Known issues / scar tissue

- **Electron 35 pin.** Upgrading requires validating `@electron/rebuild` for `better-sqlite3 11.10.0` and `node-pty` against the new ABI. Not scheduled; treat as frozen until explicitly revisited. (`package.json:83`)

- **Lock-file drift twin.** `agent-host-process.ts` is a hand-copy of the lock file shape. If `packages/runtime/src/agent-host-lock-file.ts` changes and this file is not updated, boot silently times out.

- ✅ ~~Packaged host never respawns~~ · ✅ ~~In-process API couples a server crash to the UI~~ · ✅ ~~Dev vs. packaged structural disagreement~~ — all closed by Step 7 (2026-06-04, live-verified both modes).

---

## Decisions & open questions

**For Emerson (product calls):**
1. **What does the update experience feel like?** Today it downloads on request and installs silently on the next quit. Is that the right flow, or should there be a more visible "restart now to update" prompt?
2. **macOS: is it a real target?** DMG packaging is defined but the boot sequence has never been verified on macOS. Worth confirming before anyone tries to run it.

**Technical:**
- At Step 7: should port-conflict detection live in the Supervisor (process-level) or stay in the Electron shell (UI-level)? Both have merit; decide at Step 7 scope.
- After Step 7: does `main.ts` need ANY direct knowledge of service processes, or does it discover the server URL from the Supervisor and just call `loadURL`?
- Is the `ELECTRON_RUN_AS_NODE=1` + `process.execPath` pattern for the agent host still the right mechanism once the Supervisor owns the spawn, or does it become a plain Node child?
