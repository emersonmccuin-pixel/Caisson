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

### 1. Two modes — packaged vs. dev

The shell behaves very differently depending on how it is launched:

| Mode | How it starts | What Electron owns |
|---|---|---|
| **Packaged** (`app.isPackaged`) | User runs the installed EXE | Boots API server in-process, spawns agent host as child, opens window |
| **Dev** (`PC_DESKTOP_DEV=1`, `pnpm dev` in `apps/desktop`) | Developer runs from source | Opens a window pointed at the already-running Vite dev server (`:5173`). Does NOT host the API or spawn the agent host — those are managed by `dev-supervisor.mjs` |

The dev mode exists so you can work on the Electron shell itself without disturbing the rest of the dev stack.

### 2. Boot sequence (packaged mode)

When a packaged user launches the app, this happens in order (`main.ts:206`):

1. **Port conflict check** — probes ports 4040 and 8788. If occupied:
   - Caisson-owned processes: dialog offers "Free ports & retry" — walks up to the dev-supervisor parent and `taskkill /F /T` it, waits 1.5 s, retries (`main.ts:237–252`).
   - Non-Caisson processes: dialog offers "Retry" only.
   - Two failed attempts → error dialog → quit.
2. **Start the agent host child** — spawns `agent-host.mjs` as a child process, then polls for the lock file for up to 5 seconds. If the lock never appears, kills the child and aborts boot. (`agent-host-process.ts:87`)
3. **Import the API server** — dynamically imports the esbuild server bundle (`server.mjs`) inside the Electron process itself. Because the bundle uses top-level `await`, this import only resolves after the server is fully listening. This runs the full API + database migrations + channel listener in-process. *(☠ the channel listener is removed by FD-3)* (`main.ts:186–188`)
4. **Open the window** — creates a `BrowserWindow` pointed at `http://127.0.0.1:4040`. (`main.ts:174`)

### 3. The agent host child process — and the never-respawns gap

The agent host is the process that manages all running Claude sessions. It is spawned via `spawnPackagedAgentHostProcess` using the Electron binary itself as the Node runtime (`ELECTRON_RUN_AS_NODE=1`). (`agent-host-process.ts:87`)

**📌 The critical gap:** if the agent host crashes, Electron only logs an error — there is no restart, no backoff, no user notification. Dispatched agents silently stop completing until the user relaunches the entire app. (`main.ts:279–285`)

This is the primary problem Step 7 (the Supervisor) exists to fix.

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
  - HTTP/WS on `:4040` / `:8788` — the window talks to the in-process server the same way as the browser-based dev user.

---

## Target shape (per north star + Foundation Decisions)

Per `unified-process-supervision-2026-06-02.md §3` and the consolidation ledger (§0, §2 "Spawning"):

**Electron becomes a thin UI shell only.** It owns nothing — no API hosting, no child spawning, no supervision. It opens a window and talks to the server over HTTP/WS.

**One Supervisor module** (Step 7) — `dev-supervisor.mjs` and `spawnPackagedAgentHostProcess` folded together — runs identically in dev and packaged, outside Electron, and is the only thing that spawns and respawns the server, Engine, and any other service.

Ledger verdict for `spawnPackagedAgentHostProcess` (`agent-host-process.ts`): **KEEP → fold into Supervisor** (HIGH confidence). It becomes the packaged half of the one supervisor.

What changes from today:
- The in-process `import(serverEntry)` call is deleted; the server runs in its own process managed by the Supervisor.
- `startPackagedAgentHost` moves out of `main.ts` into the Supervisor module.
- `main.ts` shrinks to: check ports (or defer to Supervisor), open window, done.
- Port-conflict handling may stay in the desktop shell (it is UI-facing) or move into the Supervisor's boot path — TBD at Step 7 scope.

☠ **FD-3 (sentenced):** the channel listener that runs inside the in-process server bundle is deleted. The Supervisor will own that responsibility directly.

---

## Known issues / scar tissue

- **Packaged host never respawns.** (`main.ts:279–285`) `child.once('exit', ...)` only logs an error — no restart, no backoff, no user notification. If the agent host crashes mid-session, agents silently stop completing until the user relaunches the app. Step 7 fixes this.

- **In-process API couples a server crash to the UI.** Because the server bundle runs inside the Electron main process, a fatal server error or `process.exit` in the server takes the window with it — violating the crash-isolation principle (`unified-process-supervision §1`). In the target shape the server is a separate process.

- **Electron 35 pin.** Upgrading requires validating `@electron/rebuild` for `better-sqlite3 11.10.0` and `node-pty` against the new ABI. Not scheduled; treat as frozen until explicitly revisited. (`package.json:83`)

- **Lock-file drift twin.** `agent-host-process.ts:1–7` is a hand-copy of the lock file shape. If `packages/runtime/src/agent-host-lock-file.ts` changes and this file is not updated, boot silently times out.

- **Dev vs. packaged structural disagreement.** Dev = three separate processes managed by `dev-supervisor.mjs`; packaged = all in-process inside Electron. This disagreement is the root cause of why supervision works in dev but not packaged.

---

## Decisions & open questions

**For Emerson (product calls):**
1. **What does the update experience feel like?** Today it downloads on request and installs silently on the next quit. Is that the right flow, or should there be a more visible "restart now to update" prompt?
2. **macOS: is it a real target?** DMG packaging is defined but the boot sequence has never been verified on macOS. Worth confirming before anyone tries to run it.

**Technical:**
- At Step 7: should port-conflict detection live in the Supervisor (process-level) or stay in the Electron shell (UI-level)? Both have merit; decide at Step 7 scope.
- After Step 7: does `main.ts` need ANY direct knowledge of service processes, or does it discover the server URL from the Supervisor and just call `loadURL`?
- Is the `ELECTRON_RUN_AS_NODE=1` + `process.execPath` pattern for the agent host still the right mechanism once the Supervisor owns the spawn, or does it become a plain Node child?
