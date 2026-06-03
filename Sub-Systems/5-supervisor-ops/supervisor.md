# Supervisor

> **Role:** Supervisor
> **Status:** as-built snapshot — 2026-06-03 · `@pc/supervisor` package built + tested, NOT yet wired in
> **Spec:** `refactor plan/supervisor-build-scope-2026-06-03.md` · `refactor plan/unified-process-supervision-2026-06-02.md`
> **Code anchors:** `packages/supervisor/src/supervisor.ts` · `packages/supervisor/src/supervised-child.ts` · `packages/supervisor/src/index.ts` · `apps/server/scripts/dev-supervisor.mjs` · `apps/desktop/src/main.ts` · `apps/desktop/src/agent-host-process.ts`

---

## What it is (plain English)

**The Supervisor is the night watchman.** Its only job is to keep the app's two service processes — the API server (Brain) and the agent host (Engine) — alive. When either one dies unexpectedly, the Supervisor waits a moment and starts it again. That's it. It holds no work of its own, has no knowledge of what the children do, and can never get into a broken state that requires it to be restarted itself. Deliberately dumb, deliberately durable.

---

## What it's supposed to do (intent)

Own the root of the process tree. Spawn the API and the agent host, watch them, and restart them automatically — with a short wait between attempts so a crashing process doesn't get into a rapid death spiral. Nothing else. No business logic, no database access.

The reason it's its own layer: **crash isolation.** If the API server crashes or hot-reloads, the Supervisor must stay alive and bring it back. If the agent host dies mid-run, the Supervisor respawns it and the Brain re-attaches from the durable state in the database.

---

## The parts (every component, plain English)

### 1. The `@pc/supervisor` package — built, tested, NOT wired in yet

> **This is the new code.** It's complete and unit-tested. It is not yet the thing running the app.

`packages/supervisor/src/` contains three files:

**`supervised-child.ts`** — the respawn engine. One instance per service process. You call `start()`; it spawns the child and watches it. When the child exits, it decides what to do:

| Exit kind | What happened | What the supervisor does |
|---|---|---|
| Graceful stop | You called `stop()` yourself first | Log it, do nothing — intentional |
| Sentinel exit (code 75) | API was asked to restart via `POST /api/dev/restart` | Restart immediately; never counts as a crash; never gives up |
| Crash (anything else) | Unexpected death | Restart with backoff; up to 3 consecutive rapid crashes before giving up |

"Consecutive rapid crashes" only counts when the process dies quickly. A process that ran healthily for 30+ seconds ("healthy uptime") resets the crash budget, so one bad deploy after a long good run always recovers.

Backoff: starts at 500 ms, doubles each attempt, caps at 8 000 ms.

Hooks let callers inject behavior at key moments: `preSpawn` (e.g. wait for a port to free), `onReady` (e.g. poll for the agent-host lock file), `onGiveUp`, `onSpawn`, `onOutput`. All dependencies (spawn, clock, delay) are injected — the whole thing is testable with a fake clock and fake process, no real processes needed.

**`supervisor.ts`** — holds an ordered list of `SupervisedChild` instances. `start()` boots them in order, waiting for each one's `onReady` gate before starting the next (the agent host must be up before the API). `stopAll()` forwards a signal to all children and suppresses respawning. Idempotent.

**`index.ts`** — the public surface re-exported as `@pc/supervisor`.

**Unit tests** (`packages/supervisor/test/supervised-child.test.ts`) cover: rapid-crash give-up, healthy-uptime budget reset, sentinel-restart never-gives-up, graceful stop suppresses respawn, `preSpawn` runs before every spawn including respawns. Fully passing.

---

### 2. The dev supervisor script — what's actually running today

`apps/server/scripts/dev-supervisor.mjs` is what `pnpm dev` in `apps/server/` actually starts. It implements the same backoff / sentinel / crash-budget logic as `@pc/supervisor` — but independently, in a standalone script, with no shared code. It:
- Spawns the API child (via `tsx`) and the agent host child.
- Waits for the agent-host lock file before starting the API.
- Waits for ports 4040 and 8788 to free before a respawn (avoids "address already in use" on fast restarts).

This script **cannot** be imported by the packaged Electron app — it relies on `tsx` internals and server-specific module resolution. That is the exact problem `@pc/supervisor` was built to fix.

---

### 3. The packaged-mode gap — the primary bug `@pc/supervisor` exists to fix

In the packaged app (the `.exe` users install), supervision is handled by `apps/desktop/src/main.ts` and `apps/desktop/src/agent-host-process.ts`. It has a critical difference from dev:

- **The API runs in-process inside Electron main** (`startInProcessServer` → dynamic `import(serverEntry)`). An API crash doesn't just stop the API — it can take down the entire Electron window.
- **The agent host is spawned as a sibling process**, but the exit handler at `main.ts:279–285` only logs the unexpected exit with `console.error`. **There is no respawn loop.** If the agent host dies in a packaged build, it stays dead until the user restarts the whole app. Every agent run becomes permanently broken in the meantime.

This is the motivating bug for wiring in `@pc/supervisor`.

There is also a "drift twin" problem: `apps/desktop/src/agent-host-process.ts:1–7` explicitly warns it is a manually maintained copy of the agent-host lock-file shape from `packages/runtime/src/agent-host-lock-file.ts`. Any change to that schema must be mirrored by hand, or host discovery breaks silently.

---

### 4. `restart-stack.ps1` — dev-stack restart utility (not a supervisor)

`scripts/restart-stack.ps1` is a developer convenience tool, not part of the production supervision path. It kills the full dev process tree, frees ports 4040/5173/8788, relaunches `pnpm dev:app`, and polls readiness. One known detail: `restart-stack.ps1:120` explicitly clears the `CLAUDE_CONFIG_DIR` env var before relaunching, because a value inherited from a Claude Code session causes the agent host to tail the wrong transcript folder.

`scripts/dev-app.mjs` is the outer coordinator that starts `pnpm dev`, Vite, and Electron together — also not a supervisor. It tears everything down on Ctrl+C.

---

## How it connects

- **Depends on:** Node.js built-ins (`child_process`) only. `@pc/supervisor` must never import `node-pty` or any heavy dependency — it must load cleanly in the Electron main process.
- **Boundary: agent-host lock file** (`data/agent-host/host.lock.json`) — the `onReady` gate polls this to confirm the host is up before the API starts.
- **Boundary: sentinel exit code 75** — the API calls `process.exit(75)` when it receives `POST /api/dev/restart`; the supervisor treats this as an intentional restart, not a crash.
- **Target consumer:** Electron `main.ts` — once wired, it imports `@pc/supervisor`, declares the API and host children, and retires both `dev-supervisor.mjs` and `spawnPackagedAgentHostProcess`.

---

## Target shape (per north star + build scope)

Per `refactor plan/unified-process-supervision-2026-06-02.md §3` and `refactor plan/supervisor-build-scope-2026-06-03.md`, **Step 7** is the one wiring task:

```
Electron main  [one supervisor — dumb, durable]
├─ API / Brain     child process · respawn-with-backoff
├─ Agent host / Engine  child process · respawn-with-backoff
└─ renderer window / UI
```

**Already done:** `@pc/supervisor` package, built and unit-tested (Step 7.1 ✅).

**Remaining (Step 7.2–7.4):**
1. Wire Electron `main.ts` to import `@pc/supervisor`; make the API a child process in both dev and packaged; remove `startInProcessServer`'s in-process import path.
2. Retire `dev-supervisor.mjs`; rewire `scripts/dev-app.mjs` to just launch Electron + Vite.
3. ONE-SUPERVISOR guard test: assert one supervisor implementation, no second respawn loop anywhere; plus unit tests for API-child-death → backoff respawn, host-child-death → backoff respawn, graceful-stop → no respawn.

**Verdicts from `consolidation-ledger-2026-06-02.md §2`:**

| Site | Verdict |
|---|---|
| `dev-supervisor.mjs` | KEEP → fold into Supervisor (Step 7) |
| `spawnPackagedAgentHostProcess` + Electron main supervision | KEEP → fold into Supervisor (Step 7); respawn gap is the bug |

Two locked decisions: **one supervisor, no `if (dev)` branch** — dev and packaged are structurally identical. **Dev speed comes from outside the app** — a file watcher rebuilds `server.mjs` on save; the sentinel-75 restart picks up the new bundle without the app knowing it's a dev tool.

---

## Known issues / scar tissue

- **Packaged host never respawns** — the primary bug. `main.ts:279–285` handles the host exit with a log line only. Dead = stays dead until the user restarts. (`apps/desktop/src/main.ts`)
- **Dev and packaged are structurally different** — API runs as a supervised child in dev but in-process in packaged. An API crash in packaged mode can take down the window. Dev testing is an unreliable proxy for packaged behavior.
- **Two supervision codebases with duplicated logic** — `dev-supervisor.mjs` and `@pc/supervisor` implement the same backoff/crash-budget/sentinel pattern independently. A bug fix must be applied to both until Step 7 lands.
- **Lock file shape is a manually maintained copy** — `agent-host-process.ts:1–7` explicitly warns of this. Any lock-file schema change must be mirrored by hand.

---

## Decisions & open questions

**For Emerson (product calls):**
- None currently. Step 7 is a pure engineering migration — no product behavior changes. Once it lands: the packaged app will silently self-heal when the agent host crashes, and a crashed API will no longer take down your window.

**Technical:**
- **Packaged respawn acceptance test.** The scope doc calls for "kill host PID → backoff respawn; kill API → backoff respawn, window survives" verified against a real packaged build. When and how is this gated?
- **Port-free wait in the new supervisor.** `dev-supervisor.mjs` waits for ports 4040/8788 to free before respawning. `SupervisedChild.hooks.preSpawn` is the designed slot — but the port-probe logic needs to be wired in when Electron main is converted. Shared utility or inline?
- **`CLAUDE_CONFIG_DIR` inheritance.** `restart-stack.ps1:120` clears this before relaunching. Does the new Electron-main supervisor need to explicitly unset it in the child env, or is it handled by the API's env normalization?
- **ONE-SUPERVISOR guard placement.** The spec calls for a guard test asserting no second respawn loop exists. Where does this live — `packages/supervisor/test/` or a workspace-level integration test?
