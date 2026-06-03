# Desktop / Electron Shell

> **Role:** UI (packaged wrapper) + interim Supervisor (packaged mode only)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `apps/desktop/src/main.ts`, `apps/desktop/src/agent-host-process.ts`,
> `apps/desktop/src/preload.ts`, `apps/desktop/src/port-conflict.ts`,
> `apps/desktop/package.json`

## What it is (plain English)

The packaged Windows app (.exe installer) that non-dev users actually run. It is an Electron
application — a stripped-down Chromium browser bundled with Node — that serves as both the window
frame for the web UI and, in packaged mode, the process that boots the API server and the agent
host. In the dev stack none of this exists: the server, agent host, and Vite frontend are all
separate processes managed by `dev-supervisor.mjs`.

## What it's supposed to do (intent)

Turn Caisson into a self-contained Windows app: one installer, one EXE, no separate Node or server
setup required. The shell starts everything a packaged user needs (API + agent host), handles
port conflicts at launch, and provides auto-update delivery from GitHub Releases.

## How it works today (as-built)

**Two modes — deliberately different:**

- **DEV mode** (`PC_DESKTOP_DEV=1`, `pnpm dev` in `apps/desktop`): Electron opens a window pointed
  at the already-running Vite dev server (`:5173`). The shell does NOT host the API or spawn the
  agent host — those run independently via `dev-supervisor.mjs`. Exists so you can iterate on the
  Electron shell itself without touching the dev stack.
- **Packaged mode** (`app.isPackaged`): Electron IS the host. It boots the API server in-process
  and spawns the agent host as a child process.

**Boot sequence (packaged):**

1. `app.whenReady()` — calls `bootPackagedServerWithGuard()` (`main.ts:206`).
2. Port-conflict check (`port-conflict.ts`) — probes ports 4040 and 8788 via
   `Get-NetTCPConnection` (Windows) or a bind test (other platforms). If occupied:
   - Caisson-owned processes: dialog offers "Free ports & retry" — walks up to the
     dev-supervisor parent and `taskkill /F /T` it, waits 1.5 s, retries (`main.ts:237–252`).
   - Non-Caisson processes: dialog offers "Retry" only.
   - Two failed attempts → error dialog → quit.
3. `startInProcessServer()` (`main.ts:174`) — sets all env vars (`PC_ROOT`, `PC_BUNDLED_CLAUDE_EXE`,
   `PC_DATA_DIR`, ports), then:
   a. `startPackagedAgentHost()` — spawns the agent host as a child (`agent-host-process.ts:87`).
      Polls for the lock file (`agent-host/<hostId>/host.lock.json`) for up to 5 s.
      If the lock never appears, kills the child and throws (aborts boot).
   b. `import(serverEntry)` — dynamically imports the esbuild server bundle (`server.mjs`)
      inside the Electron process. This runs the full Hono API + SQLite migrations + channel
      listener in-process. Because the bundle has top-level `await`, the import resolves only
      after the server is actually listening (`main.ts:186–188`).
4. `createWindow()` — opens the `BrowserWindow` pointed at `http://127.0.0.1:4040`.

**Agent host child process:**

- Spawned via `spawnPackagedAgentHostProcess` (`agent-host-process.ts:87`), which runs
  `agent-host.mjs` inside the Electron binary itself (`ELECTRON_RUN_AS_NODE=1`,
  `process.execPath` as the command).
- stdout/stderr piped back to the main process's own stdio (`main.ts:273–278`).
- On unexpected exit: **only a `console.error` is emitted** — no respawn (`main.ts:279–285`).
  This is the known gap (see Known issues).
- On app quit: `stopPackagedAgentHost()` sends a graceful HTTP shutdown request to the host's
  command port (read from the lock file), waits 2 s, then `SIGTERM` if still alive (`main.ts:298–309`).

**Lock file handshake (`agent-host-process.ts`):**

- Old lock file deleted before spawn (`removePackagedAgentHostLockFile`).
- Main polls `statSync` every 100 ms until the file's `mtimeMs ≥ startedAt`, up to 5 s.
- Lock file contains: `{ pid, hostId, port, startedAt, protocolVersion: 1 }`.
- ⚠️ DRIFT TWIN: the lock file shape is hand-copied in `agent-host-process.ts:1–7` because
  importing `@pc/runtime` would pull `node-pty` into the desktop bundle (ABI conflict with
  Electron's Node version). Any lock file schema change must be mirrored by hand.

**Preload (`preload.ts`):**

- Minimal surface exposed via `contextBridge` as `window.pcDesktop`.
- Exposes: `isDesktop: true`, `platform`, and `updates` (get/check/download/install/subscribe).
- Update state is owned by the main process and pushed to the renderer over IPC channel
  `pc:update-state`. The renderer never touches `autoUpdater` directly.
- No Node bridge for general use — the web UI talks to the server over HTTP/WS as normal.

**Auto-update:**

- `electron-updater` reads from the public GitHub Releases feed
  (`emersonmccuin-pixel/Caisson`, `main.ts:31–33` in `package.json` build config).
- User-driven: `autoDownload: false`. Auto-installs a downloaded update on quit
  (`autoInstallOnAppQuit: true`).
- In DEV mode the updater is disabled; `updateState.status` stays `'unsupported'`.

**Electron version pin:**

- `"electron": "^35.0.0"` (`package.json:83`). Electron 35 ships Node ~20.
  Electron 42 would use a newer V8/Node ABI that breaks `better-sqlite3 11.10.0`'s
  pre-built native bindings, requiring a full native rebuild that has not been validated.
  Pin stays until that rebuild is confirmed safe.

**Build / packaging:**

- `prepackage` script: builds main bundle (esbuild), web bundle (Vite), server bundle,
  agent-host bundle, stages all resources under `staging/pcserver/`, stages the pinned
  `claude.exe` under `staging/claude/`, rebuilds native modules against Electron's ABI
  via `@electron/rebuild`.
- `extraResources` in electron-builder config copies `staging/pcserver → resources/pcserver`
  and `staging/claude → resources/claude` into the installed app (`package.json:43–52`).
- Output: NSIS installer (`Caisson Setup.exe`) for Windows; DMG + ZIP for macOS.

## Integrations (how it connects)

- **Depends on:** `@pc/server` (the bundled API, imported in-process in packaged mode);
  `@pc/agent-host` (spawned as a child); `packages/runtime` lock file shape (via drift twin).
- **Used by:** end users (the packaged installer); `pnpm dev` in `apps/desktop` for shell
  iteration (DEV mode only).
- **Contracts / events crossed:**
  - Lock file (`agent-host/host.lock.json`) — the only handshake between main and the agent
    host at boot.
  - IPC channels `pc:update-state`, `pc:update:get-state`, `pc:update:check`,
    `pc:update:download`, `pc:update:install` — between main process and renderer.
  - HTTP/WS on `:4040` / `:8788` — renderer talks to the in-process server the same way as
    the browser-based dev user.

## Target shape (per north star)

Per `unified-process-supervision-2026-06-02.md §3` and the ledger (§0, §2 "Spawning"):

- **Electron becomes a thin UI shell only.** It owns nothing — no API hosting, no child
  spawning, no supervision. It opens a window and talks to the Brain over HTTP/WS.
- **One Supervisor module** (`dev-supervisor.mjs` + `spawnPackagedAgentHostProcess` folded
  together — Step 7 in the migration) runs identically in dev and packaged, outside Electron,
  and is the only thing that spawns and respawns the Brain, Engine, and any other service.
- Ledger verdict for `spawnPackagedAgentHostProcess` (`agent-host-process.ts`):
  **KEEP → fold into Supervisor** (HIGH confidence). It becomes the packaged half of the one
  supervisor.
- What changes from today:
  - The in-process `import(serverEntry)` call is deleted; the server runs in its own process
    managed by the Supervisor.
  - `startPackagedAgentHost` moves out of `main.ts` into the Supervisor module.
  - `main.ts` shrinks to: check ports (or defer to Supervisor), open window, done.
  - Port-conflict handling may stay in the desktop shell (it is UI-facing) or move into
    the Supervisor's boot path — TBD at Step 7 scope.

## Known issues / scar tissue

- **Packaged host never respawns.** The `child.once('exit', ...)` handler at `main.ts:279`
  only logs `console.error` — no restart, no backoff, no user notification. If the agent host
  crashes mid-session, dispatched agents silently stop completing until the user relaunches the
  app. This is the primary gap Step 7 (Supervisor) fixes.
  (`main.ts:279–285`)

- **In-process API couples Brain crash to UI.** Because the server bundle runs inside the
  Electron main process, a fatal server error or a top-level `process.exit` in the server
  bundle takes the Electron window with it — violating the crash-isolation principle
  (`unified-process-supervision §1`). In the target shape the server is a separate process.

- **Electron 35 pin.** `"electron": "^35.0.0"` (`package.json:83`). Upgrading to Electron 42+
  requires validating `@electron/rebuild` for `better-sqlite3 11.10.0` and `node-pty` against
  the new ABI. Not scheduled; treat as a frozen constraint until explicitly revisited.

- **Lock-file drift twin.** `agent-host-process.ts:1–7` documents the hand-copy risk. If the
  lock file shape changes in `packages/runtime/src/agent-host-lock-file.ts` and this file is
  not updated, the desktop shell will fail to discover the host at boot (silent timeout).

- **Dev mode is structurally different.** Dev stack = three separate processes
  (`dev-supervisor.mjs` + `pnpm dev` server + `pnpm --filter @pc/web dev` Vite); packaged =
  all in-process inside Electron. This structural disagreement is the root of why supervision
  works in dev but not packaged (dev-supervisor respawns; Electron does not).

## Open questions

- At Step 7: should port-conflict detection live in the Supervisor (process-level) or stay in
  the Electron shell (UI-level)? Both have merit; decide at Step 7 scope.
- After Step 7: does `main.ts` need ANY direct knowledge of service processes, or does it
  discover the server URL from the Supervisor and just `loadURL`?
- Is the `ELECTRON_RUN_AS_NODE=1` + `process.execPath` pattern for the agent host still the
  right mechanism once the Supervisor owns the spawn, or does it become a plain Node child?
- macOS packaging is defined in `package.json` but not verified end-to-end. Notarization
  and hardened-runtime entitlements are configured — unknown if the packaged boot sequence
  (lock file, in-process server) has been tested on macOS. (unverified)
