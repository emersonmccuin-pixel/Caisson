# Supervisor build scope (Step 7) — ONE RUNTIME — rev 2026-06-03

**Decision (user, 2026-06-03):** there is ONE runtime, full stop — the Electron app.
There is **no "dev mode."** The app boots exactly one way, always: Electron main
supervises the API child + host child, runs the shipped **bundle**, with **no
`app.isPackaged` branch anywhere** in its boot or logic. `dev-supervisor.mjs` is
**retired**.

**"Development" is tooling AROUND the one app, not a mode of it.** A watcher rebuilds
the bundle on save + triggers the existing restart; the UI dev-server gives hot-reload.
The app has no knowledge of them — they feed it artifacts, they don't fork its code.
The one discipline that keeps this honest: anything that *could* differ (e.g. the URL
the window loads the UI from) is read from **one config value** (like the data dir and
ports already are), never an `if (dev)` branch. One value → one code path.

Net: one true runtime (what you test is what ships) AND a fast edit→build→see loop.
The API child command is therefore ALWAYS `node server.mjs` (the bundle) — no tsx
branch; dev's speed comes from the outside watcher rebuilding that bundle, not from a
second way of running the app.

**Status:** scoped, not built. Gated — build on approval.

---

## The one process tree (dev === packaged)

```
Electron main  [THE supervisor — dumb, durable, the only one]
├─ API / Brain     child process · respawn-with-backoff
├─ Agent host /Engine  child process · respawn-with-backoff
└─ renderer window / UI
```

The app boots this tree the same way always — `node server.mjs` for the API child,
the host child, the renderer loading its UI from **one configured URL**. Supervision
— spawn → watch → respawn-with-backoff, crash budget, lock-wait, port-free wait,
sentinel-75 restart — is **one implementation**.

**Dev tooling sits outside this tree** and changes none of it: a bundle watcher
rebuilds `server.mjs` on save → the supervisor's existing exit-75 restart picks it up;
the UI dev-server serves HMR at the URL the window is already configured to load. The
app cannot tell dev tooling apart from a packaged launch. The only "difference" is the
*value* of the UI URL (dev-server vs built assets) and config like data dir / ports —
inputs, read once, not code branches.

---

## Two things this corrects (vs the old scope)

1. **One supervisor, not a shared primitive with two callers.** The earlier scope
   kept `dev-supervisor.mjs` AND Electron main both calling a shared module — still
   two builds. Killed. Electron main is the sole supervisor; the proven respawn logic
   moves out of `dev-supervisor.mjs` into it.
2. **API becomes a child in both modes — no more in-process API.** Today packaged
   runs the API *inside* the Electron main process (`startInProcessServer` →
   `import server.mjs`). That means an API crash can take down the window, and it's
   structurally different from dev. Making the API a supervised child **always** gives
   crash isolation (Supervisor ≠ Brain, per the architecture) and makes dev and
   packaged identical.

---

## Build order

1. **Supervisor core** — a node-builtins-only module Electron main imports (must NOT
   pull `node-pty` into the main bundle): `SupervisedChild` (spawn → watch →
   respawn-backoff + healthy-uptime reset + `MAX_CRASH_RESTARTS` give-up + optional
   `readyGate`/lock-wait + `preSpawn`/port-free-wait + sentinel-75 restart) and a
   `Supervisor` holding a **data-driven child list**. Port the logic out of
   `dev-supervisor.mjs`. Unit-tested with a fake `spawnImpl` + fake clock.
2. **Electron main boots the supervisor, always.** Spawn the API child + host child;
   the renderer already talks to the API over HTTP, so it doesn't care. Remove
   `startInProcessServer`'s in-process `import`; the API child's command is the bundle
   (packaged) or tsx entry (dev). Keep the lock-wait gate before declaring ready.
3. **Retire `dev-supervisor.mjs`.** Rewire `scripts/dev-app.mjs` so dev just launches
   the Electron app (which now supervises API + host) + Vite. `POST /api/dev/restart`
   → exit 75 → the supervisor respawns the API child (preserved, now in Electron main).
4. **Guard test (ONE-SUPERVISOR).** Assert there is exactly one supervisor
   implementation and no second respawn loop anywhere; plus unit tests that both an API
   child exit and a host child exit trigger a backoff respawn (not a log line), and
   that a graceful stop suppresses respawn.

**Data-driven child list** so Steps 4–6 (orchestrator + modals move onto the host)
need no supervisor change — they become host sessions, not new service processes.

---

## Out of scope (named, not skipped)

- **Electron-main self-crash.** If the supervisor process itself dies the app is gone;
  that's OS/relaunch territory, not self-respawnable. Not covered here.

---

## Risk — HIGH (changes how the whole app boots, both modes)

Mitigation — land in order, verify each before the next:
1. Supervisor core + unit tests green (no app change yet).
2. Cut DEV over first: edit → `/api/dev/restart` respawns the API child, host stays,
   UI reconnects; kill host PID → respawns with backoff.
3. Then packaged: boots via the supervisor; kill host → respawns; kill API → respawns
   and the window survives the API crash.

## Acceptance

- Dev: edit → restart respawns API child, host stays up, UI reconnects.
- Dev + packaged: kill host PID → backoff respawn; kill API → backoff respawn, window
  survives.
- ONE-SUPERVISOR guard green · workspace typecheck green · server tests green.
