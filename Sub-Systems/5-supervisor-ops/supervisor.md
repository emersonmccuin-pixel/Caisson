# Supervisor

> **Role:** Supervisor
> **Status:** as-built snapshot — 2026-06-04 · **Step 7 SHIPPED + live-verified (dev AND packaged)** — Electron main is THE supervisor
> **Spec:** `refactor plan/supervisor-build-scope-2026-06-03.md` · `refactor plan/unified-process-supervision-2026-06-02.md`
> **Code anchors:** `packages/supervisor/src/` (supervised-child · supervisor · waits) · `apps/desktop/src/main.ts` · `apps/desktop/src/agent-host-process.ts` · `scripts/dev-app.mjs`

---

## What it is (plain English)

**The Supervisor is the night watchman.** Its only job is to keep the app's two service processes — the API server (Brain) and the agent host (Engine) — alive. When either one dies unexpectedly, the Supervisor waits a moment and starts it again. It holds no work of its own, has no knowledge of what the children do, and can never get into a broken state that requires it to be restarted itself. Deliberately dumb, deliberately durable.

**There is ONE runtime.** The app boots exactly one way, always: Electron main supervises the API child + host child, both running the shipped bundles (`node server.mjs` / `host.mjs`). There is no "dev mode" of the app — dev tooling rebuilds the bundles on save and serves the UI with hot reload, but the app can't tell it apart from a packaged launch. What you test is what ships.

```
Electron main  [THE supervisor — dumb, durable, the only one]
├─ agent-host  child · respawn-with-backoff · lock-file ready gate
├─ api         child · respawn-with-backoff · sentinel-75 restart
└─ renderer window / UI
```

---

## The parts (as built)

### 1. `@pc/supervisor` — the respawn engine (node builtins only)

**`supervised-child.ts`** — one instance per service process. On exit it decides:

| Exit kind | What happened | Response |
|---|---|---|
| Graceful stop | `stop()` was called first | Log, do nothing — intentional |
| Sentinel exit (75) | API asked to restart (`POST /api/dev/restart`) | Respawn with its own backoff; never a crash; never gives up |
| Crash (anything else) | Unexpected death | Respawn with backoff (500 ms → 8 s cap); >3 consecutive rapid crashes → give up |

A run healthy for 30+ s resets the crash budget. Hooks: `preSpawn` (port-free wait), `onReady` (lock-file gate), `onOutput` (log tee), `onGiveUp` (loud dialog + quit), `requestStop` (polite ask instead of a signal — the host's HTTP shutdown), `onSpawn`. All deps injected (spawn/clock/delay) — fully unit-tested with fakes.

**`supervisor.ts`** — the ordered child list. `start()` boots in order awaiting each ready gate (host's lock before the API). `stopAll()` suppresses respawn + signals everyone. **`stopAndWait(signal, deadline)`** — graceful stop that escalates to SIGKILL past the deadline; it never hangs.

**`waits.ts`** — the shared gates: `waitForPortsFree` (preSpawn), `waitForPortsBound` (API answered = window worth opening), `waitForFreshFile` (host lock with mtime ≥ this spawn — a stale lock never counts).

### 2. Electron main (`apps/desktop/src/main.ts`) — the one consumer

- `resolveStackConfig()` — THE config door. Entry paths, node binary, data dir, port, window URL are **inputs** with packaged defaults; dev tooling overrides via env (`PC_API_ENTRY`, `PC_HOST_ENTRY`, `PC_CHILD_NODE`, `PC_DATA_DIR`, `PC_DESKTOP_URL`). No `if (dev)` in boot logic; `PC_DESKTOP_DEV` only labels the window (title/icon).
- Boot: port-conflict guard (one path, both modes) → `supervisor.start()` → wait API bound → window.
- Quit: ONE path — `before-quit` → `stopAndWait` (host gets its polite HTTP `shutdown host-exit`; stragglers SIGKILLed at 5 s) → quit. Verified live: graceful close leaves zero orphans and removes the lock.
- Children's output tees to `<dataDir>/diagnostics/children.log`.
- ☠ Step 7 demolition: `startInProcessServer` (packaged in-process API import — an API crash could take the window down) and the one-shot host spawn with **no respawn** (the motivating bug) are DELETED. `agent-host-process.ts` keeps only the lock-file helpers + HTTP shutdown ask (still a hand-mirrored DRIFT TWIN of `@pc/runtime`'s lock-file shape).

### 3. Dev tooling (`scripts/dev-app.mjs`) — around the app, not a mode of it

`pnpm dev:app` (= `pnpm dev`): one-shot bundle builds (server · host · mcp) → esbuild `--watch` rebuilds on save → Vite (:5173) → the Electron app pointed at the repo's dist bundles via env. Loading rebuilt code: server → `POST /api/dev/restart` (exit 75 → respawn); host → kill its pid from the lock file (supervisor respawns). ☠ `dev-supervisor.mjs` + `dev-supervisor-processes.mjs` DELETED. `restart-stack.ps1` unchanged in role (kills the dev-app tree, relaunches, polls readiness).

Native modules: the bundles keep `better-sqlite3`/`node-pty` external. Dev resolves the repo's Node-ABI builds (declared in `@pc/server` / `@pc/agent-host` deps so the walk-up from `dist/` finds them) and runs children with the **system node** (`PC_CHILD_NODE`); packaged resolves the staged Electron-ABI rebuilds and runs children as `Caisson.exe` + `ELECTRON_RUN_AS_NODE`.

### 4. The ONE-SUPERVISOR gate

`packages/supervisor/test/one-supervisor-gate.test.ts` — static guard: the retired dev-supervisor files stay deleted; banned resurrections (`startInProcessServer`, `spawnPackagedAgentHostProcess`, …) fail the gate anywhere in source; only `apps/desktop/src/main.ts` may construct supervision primitives; the api child keeps sentinel 75.

---

## How it connects

- **Depends on:** Node builtins only — `@pc/supervisor` must never pull `node-pty` (it loads in Electron main).
- **Boundary: agent-host lock file** (`<dataDir>/agent-host/host.lock.json`) — fresh-mtime ready gate; removed before every host spawn; the API re-discovers the new host through it.
- **Boundary: sentinel 75** — `POST /api/dev/restart` → `process.exit(75)` → respawn. Dev-controls stay dev-only via the "no `PC_ROOT`" heuristic (dev children run the repo bundle, which derives the trunk from its own path — so no `PC_ROOT` is set).
- **Boundary: HTTP `shutdown host-exit`** — the supervisor's `requestStop`; the host destroys its live `/events` sockets with a deadline and exits (fixed 2026-06-04; was the shutdown-never-exits bug).

---

## Live acceptance (2026-06-04, both modes)

- **Dev:** `POST /api/dev/restart` → api child respawned (`exit 75` line in log), host untouched, window alive · kill host pid → `crashed … auto-respawning in 500ms (recovery 1/3)` → fresh lock, health ok, cap re-pushed.
- **Packaged** (`release/win-unpacked/Caisson.exe`, scratch data dir): kill api child → respawned, :PORT answers, window survives · kill host → respawned, fresh lock · graceful close → all children exited, lock removed.
- Found + fixed during cutover: FD-15 `set-config` receipt was rejected as malformed (client validator lacked the case; host applied but every connect logged push-failed) — real client↔host round-trip regression tests added.

---

## Known issues / scar tissue

- **Electron-main self-crash** is out of scope (named in the build scope): if the supervisor process dies the app is gone — OS/relaunch territory.
- **Lock file shape is a manually maintained copy** — `agent-host-process.ts` DRIFT TWIN warning stands.
- **Packaging needs a 2.1.160 CLI source** (FD-22 pin) while the local install is drifted to .162 — `stage-claude` refuses drift; point `PC_CLAUDE_SRC` at a pinned binary (stash: `E:\tmp\claude-160\claude.exe`).
- Old `pnpm dev` muscle memory (API-only, tsx) is gone — the stack IS the app now; headless API-only runs no longer exist.

---

## Decisions & open questions

**For Emerson (product calls):**
- None open. As shipped: the packaged app self-heals a dead background service, and a crashed API no longer takes your window down.

**Technical:**
- `CLAUDE_CONFIG_DIR` inheritance is scrubbed by `dev-app.mjs` AND `restart-stack.ps1` (host would tail the wrong transcript folder). The packaged app doesn't inherit it from a CC session by construction — no further handling needed.
