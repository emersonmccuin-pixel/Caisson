# Supervisor

> **Role:** Supervisor
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `packages/supervisor/src/supervised-child.ts`, `packages/supervisor/src/supervisor.ts`, `packages/supervisor/src/index.ts`, `apps/server/scripts/dev-supervisor.mjs`, `apps/desktop/src/main.ts`, `apps/desktop/src/agent-host-process.ts`

## What it is (plain English)

The Supervisor's only job is to keep the app's service processes (the API/Brain server and the agent host/Engine) running. When one of those processes dies unexpectedly, the Supervisor waits a moment and restarts it — automatically. It holds no work state of its own; it is deliberately "dumb" so it can never itself be the thing that goes wrong and stays wrong.

## What it's supposed to do (intent)

Own the root of the process tree. Spawn each service child, watch it, and respawn it with exponential backoff if it dies — whether that's a crash, a boot failure, or an intentional restart signal. Nothing else. No business logic, no DB access, no knowledge of what the children do.

The reason it's separate: crash isolation. If the Brain (API server) hot-reloads, crashes, or deploys a new build, the Supervisor must stay alive and bring the Brain back. If the Engine (agent host) crashes mid-run, the Supervisor respawns it; the Brain re-attaches and re-dispatches from durable intent in the DB.

## How it works today (as-built)

**The new package (`packages/supervisor`) exists and is built — it is NOT yet wired into the app.**

### What's in `packages/supervisor/src/`

- **`supervised-child.ts`** — the respawn engine. One `SupervisedChild` object per service process.
  - `start()` — spawns the child and begins watching.
  - On exit: distinguishes three cases:
    1. **Graceful stop** (`stop()` was called first) → log and do nothing.
    2. **Sentinel exit** (configurable exit code, default: `null`; dev uses `75`) → its own backoff sequence; never counts as a crash; never gives up. This is how `POST /api/dev/restart` works today — the API exits with code 75 and the supervisor restarts it.
    3. **Crash** (any other exit) → exponential backoff; up to `maxCrashRestarts` (default: 3) consecutive rapid crashes before giving up. A child that ran "healthy" (uptime ≥ `healthyUptimeMs`, default: 30 s) resets the crash budget, so a transient crash after a long healthy run always recovers.
  - Backoff: starts at 500 ms, doubles per attempt, caps at 8 000 ms (`DEFAULT_RESTART_POLICY`).
  - Hooks: `preSpawn` (e.g. wait for a port to free), `onReady` (e.g. poll a lock file), `onOutput`, `onGiveUp`, `onSpawn`.
  - Dependencies (`spawn`, `now`, `delay`) are injected, making it fully unit-testable with a fake clock and fake spawn.

- **`supervisor.ts`** — holds a declared, ordered list of `SupervisedChild` instances.
  - `start()` — starts children in order, awaiting each one's `onReady` gate before the next. Order expresses the dependency: agent host must publish its lock file before the API boots.
  - `stopAll(signal)` — forwards a signal to every child and suppresses their respawn. Idempotent.

- **`index.ts`** — re-exports the above (the public surface of `@pc/supervisor`).

- **`test/supervised-child.test.ts`** — unit tests using fake spawn + fake clock. Covers: rapid-crash give-up, healthy-uptime budget reset, sentinel-restart never-gives-up, graceful stop suppresses respawn, `preSpawn` runs before every spawn including respawns.

### What currently runs the app (not yet replaced)

There are **two separate supervision implementations** today — neither uses `packages/supervisor`:

1. **Dev mode** (`apps/server/scripts/dev-supervisor.mjs`) — a standalone script that spawns the API child (via tsx) and the agent host child; respawns both with the same backoff/sentinel/crash-budget logic; waits for the agent host lock file before starting the API; waits for ports 4040/8788 to free before a respawn. This is started by `pnpm dev` in `apps/server/`.

2. **Packaged mode** (`apps/desktop/src/main.ts` + `apps/desktop/src/agent-host-process.ts`) — Electron main imports the API bundle *in-process* (`startInProcessServer` → dynamic `import(serverEntry)`), meaning an API crash can take down the Electron window. It also spawns the agent host as a sibling process (`spawnPackagedAgentHostProcess`) but **does not respawn it on death** — the `child.once('exit', …)` handler at `main.ts:279` only logs the unexpected exit; there is no respawn loop.

`scripts/dev-app.mjs` is the outer launcher that starts `pnpm dev` (which runs `dev-supervisor.mjs`), Vite, and Electron. It is not a supervisor — it is a convenience coordinator that tears down everything on Ctrl+C. `scripts/restart-stack.ps1` is the dev-stack restart utility: it kills the full process tree, frees ports, relaunches `pnpm dev:app`, and polls readiness.

### Where state lives

The Supervisor is stateless by design. Each `SupervisedChild` tracks only: the live `ChildProcess` reference, the `stopping` flag, a crash counter, a sentinel-attempt counter, and `startedAt` timestamps. No DB. No business state.

## Integrations (how it connects)

- **Depends on:** nothing beyond Node.js built-ins (`child_process`). `packages/supervisor` must never import `node-pty` or any heavy dependency — it needs to load cleanly in the Electron main process.
- **Used by (target):** Electron `main.ts` — which will import `@pc/supervisor` and declare the API child + host child as its supervised list. Today `main.ts` uses `spawnPackagedAgentHostProcess` directly and imports the API in-process.
- **Used by (today — dev only):** `apps/server/scripts/dev-supervisor.mjs` implements the same logic manually, independent of `packages/supervisor`.
- **Contracts / events crossed:**
  - Agent host lock file (`data/agent-host/host.lock.json`) — the `onReady` gate polls this to know the host is up before booting the API. Described in `apps/desktop/src/agent-host-process.ts`; the lock file shape is a manually mirrored twin of `packages/runtime/src/agent-host-lock-file.ts` to avoid pulling `node-pty` into the desktop bundle.
  - Sentinel exit code `75` — the API server calls `process.exit(75)` when asked to restart (via `POST /api/dev/restart`); the supervisor treats this as an intentional restart, not a crash.

## Target shape (per north star)

Per `refactor plan/unified-process-supervision-2026-06-02.md` §3 and `refactor plan/supervisor-build-scope-2026-06-03.md`:

**The target is a single process tree, identical in dev and packaged, with Electron main as the one and only supervisor:**

```
Electron main  [supervisor — dumb, durable, the only one]
├─ API / Brain     child process · respawn-with-backoff
├─ Agent host / Engine  child process · respawn-with-backoff
└─ renderer window / UI
```

Key decisions already locked (per `supervisor-build-scope-2026-06-03.md`):

- **One supervisor, not two.** `dev-supervisor.mjs` is retired. Electron main imports `@pc/supervisor` and uses it in both dev and packaged. There is no `if (dev)` branch.
- **API becomes a child process always.** Today the packaged app imports the API in-process. That will change: the API runs as a supervised child (`node server.mjs`) in both modes. This gives crash isolation (an API crash can't kill the window) and makes dev and packaged structurally identical.
- **Dev speed comes from outside the app.** A file watcher rebuilds `server.mjs` on save; the supervisor's existing sentinel-75 restart picks up the new bundle. The app itself has no knowledge of dev tooling.
- **Data-driven child list.** `packages/supervisor` already supports this: `Supervisor` takes a declared list of `SupervisedChild` instances. Steps 4–6 (moving orchestrator + modals onto the Engine) add host sessions, not new supervised service children — so the supervisor needs no changes when those steps land.

**Verdicts from `consolidation-ledger-2026-06-02.md` §2:**

| Site | Verdict |
|------|---------|
| `dev-supervisor.mjs` | **KEEP → fold into Supervisor (Step 7)** — dev half of the one supervisor |
| `spawnPackagedAgentHostProcess` + Electron main supervision | **KEEP → fold into Supervisor (Step 7)** — packaged half; respawn gap is the bug |

**Build order (from `supervisor-build-scope-2026-06-03.md`):**

1. ✅ Supervisor core (`packages/supervisor`) — built + unit-tested.
2. Wire Electron main to use `@pc/supervisor`, make API a child process in both modes. Remove `startInProcessServer`'s in-process import path.
3. Retire `dev-supervisor.mjs`. Rewire `scripts/dev-app.mjs` to just launch Electron + Vite.
4. ONE-SUPERVISOR guard test: assert one supervisor implementation + no second respawn loop anywhere; plus unit tests for API-child-death and host-child-death → backoff respawn, and graceful-stop → no respawn.

## Known issues / scar tissue

- **Packaged host never respawns.** This is the primary motivating bug for Step 7. `apps/desktop/src/main.ts:279–285` handles the host's `exit` event with a `console.error` only. If the host process dies in a packaged build, it stays dead — no respawns, no backoff, no recovery. All agent runs on a packaged build become permanently broken until the user restarts the app.
- **Dev and packaged are structurally different.** Dev: API runs as a child of `dev-supervisor.mjs`, fully supervised and respawnable. Packaged: API runs in-process inside Electron main. An API crash in packaged mode takes down the whole window. This makes dev testing unreliable as a proxy for packaged behavior.
- **Two supervision codebases with duplicated logic.** `dev-supervisor.mjs` and the `packages/supervisor` package implement the same backoff/crash-budget/sentinel pattern independently. Any bug fix or policy change must be applied in two places until the migration lands.
- **`dev-supervisor.mjs` is not importable by the desktop.** It uses `tsx` CLI internals, raw file system operations, and module-resolution tricks specific to the server's directory. It cannot be reused in Electron without a rewrite — which is exactly what `packages/supervisor` provides.
- **`agent-host-process.ts` lock file shape is a manually maintained copy.** `apps/desktop/src/agent-host-process.ts:1–7` explicitly warns it is a "DRIFT TWIN" of `packages/runtime/src/agent-host-lock-file.ts`. Any change to the lock file schema must be mirrored by hand or host discovery breaks silently.

## Open questions

- **Acceptance test for packaged respawn.** The scope doc calls for verifying packaged-mode: "kill host PID → backoff respawn; kill API → backoff respawn, window survives." This requires a packaged build test, not just unit tests. How/when is this gated?
- **Port-free wait in the new supervisor.** `dev-supervisor.mjs` waits for ports 4040/8788 to free before respawning the API (to avoid EADDRINUSE on fast restarts). `SupervisedChild.hooks.preSpawn` is the designed hook for this — but it needs to be wired up with the port-probe logic when Electron main is converted. Does this move into a shared utility or stay inline?
- **`CLAUDE_CONFIG_DIR` inheritance.** `scripts/restart-stack.ps1:120` clears this env var before relaunching because a value inherited from a Claude Code session causes the host to tail the wrong transcript folder. Does the new Electron-main supervisor need to explicitly unset this in the child env, or is it handled elsewhere (e.g. by the API's env normalization)?
- **ONE-SUPERVISOR guard placement.** The spec calls for a guard test asserting no second respawn loop. Where does this live — `packages/supervisor/test/` or a workspace-level integration test?
