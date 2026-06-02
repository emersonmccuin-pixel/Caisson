# Process & Lifecycle Architecture — first principles

**Date:** 2026-06-02
**Status:** target design (build against this)
**Companions:** `agent-subsystem-analysis-2026-06-02.md`, `one-agent-dispatch-door-2026-06-02.md`,
`workflow-engine-first-principles-redesign-2026-06-02.md`.
**Guiding rule:** one owner per concern, one path per job. A refactor deletes the old path; the
instant two paths do the same job, collapse them — never keep a fallback.

This doc describes how the system **should** be, derived from its constraints — not how it is today.
Current state appears only in §9 (the migration's starting point).

---

## 1. First principles (the constraints everything falls out of)

1. **Crash isolation.** The component that *owns* AI processes is separate from the components that
   reload or crash (the brain in dev hot-reload; the UI). A brain or UI crash must never kill running
   work.
2. **One source of truth.** An append-only **event log** is the truth. All live state (run status,
   session state, card position) is a **projection** of it — rebuildable at any time.
3. **Positive signals only.** "Ready", "done", "paused" are *explicit receipts*. The only thing
   allowed to end work by inference is a **typed failure with a reason** (timeout, crash) — never a
   silent hang, never a fake success.
4. **Durable intent, disposable processes.** Work survives because the *intent* lives in the store,
   not because a process stays alive. If a process dies, its run fails-with-reason and is
   re-dispatchable. Don't keep zombie processes alive to preserve state — restart from the store.
   ("Let it crash.")
5. **One owner per concern, one path per job.** No fallbacks, no two things doing the same job.

---

## 2. Components (the minimal set those principles demand)

| Component | Job | Owns | Restart-safe? |
|---|---|---|---|
| **Supervisor** | keep the service processes alive | nothing (stateless, dumb) | it's the root — trivial by design so it never needs to |
| **Engine (host)** | sole owner of every `claude.exe`; one session lifecycle; worker pool | the AI processes | yes — on restart, in-flight runs fail-with-reason + re-dispatch from the store |
| **Brain** | control plane: workflow engine, the ONE reconciler, routing, read-models | the Store | yes — the Engine keeps work alive across a brain reload |
| **Store** | append-only event log + projected read-models | the truth | durable |
| **UI shell** | pure view + input | nothing | yes — reattaches to the Brain |

Five roles. The per-session **MCP child** stays (it is the agent's hands; its tools call back into
the Brain). It changes nothing about ownership — the Engine owns the parent `claude.exe`.

---

## 3. The ideal process tree

```
Supervisor  [root proc — dumb, durable]
│   spawn → watch → respawn-with-backoff; ONE implementation, identical dev & packaged
├─ Brain  [proc]   control plane
│    • workflow engine · ONE reconciler · routing · read-models
│    • owns the Store (event log = truth)
│    • spawns NO claude.exe — it asks the Engine
├─ Engine / host  [proc]   the SINGLE owner of every claude.exe
│    • one session lifecycle · one ready-detector · one transcript reader
│    • a worker pool: admits/queues sessions, caps concurrency
│    ├─ session: orchestrator   [claude]  policy{persistent, interactive, fire-and-watch}
│    │    └─ MCP child  [proc]  → tools call back to Brain
│    ├─ session: agent worker   [claude]  policy{one-shot, awaited, pausable}
│    │    └─ MCP child  [proc]
│    └─ session: modal          [claude]  policy{ephemeral, streaming}
│         └─ MCP child  [proc]
└─ UI shell  [proc]  Electron/renderer (or browser)
     • talks to Brain over HTTP/WS · reattachable · owns nothing
```

Orchestrator, agent, and modal differ ONLY by a **policy record** on one primitive — not a separate
class, state machine, or owner.

---

## 4. The one session lifecycle (the unified primitive)

```
pending ──► starting ──► ready ──► working ──┬──► done(completed)
                                    ▲   │     │
                                    │   └────►├──► waiting (explicit ask)
                                    └─────────┘     │
                                                    └──(answer)──► working
   any state ───────────────────────────────────────► done(failed: <reason>)
```

| Transition | Driver | Kind |
|---|---|---|
| pending → starting | pool admits (concurrency slot) | control |
| starting → ready | MCP handshake + ready-gate | **positive** |
| working → waiting | agent calls an explicit ask tool | **positive** |
| working → done(completed) | agent submits its deliverable | **positive — the sole "good done"** |
| * → done(failed: reason) | process exit / idle / wall-clock | typed failure (only inferred ending) |

**Policy flags** (orthogonal, not subtypes): `persistent | one-shot | ephemeral` ·
`awaited | fire-and-watch` · `interactive | single-input` · `pausable`.

---

## 5. The one control loop (the reconciler)

The Brain runs a single loop, like a Kubernetes controller:

```
for each non-terminal run in the Store:
    observed = Engine's authoritative report for this run
    • Engine says terminal       → finalize from the report (idempotent)
    • Engine unreachable          → HOLD. never finalize on no-information.
    • Engine reachable, run gone  → confirm over N ticks → done(failed: lost) → re-dispatchable
```

One loop, every state (pending/starting/working/waiting), mode-agnostic. **Boot is the same loop.**
There is no second listener, no sweep, no per-run timer competing — so the listener race that strands
runs today **cannot be expressed** in this model.

---

## 6. How a finish wakes a waiter (no race by construction)

The Engine emits **one** authoritative `done` event. The reconciler is its **one** consumer. It:
1. appends the terminal event to the log (truth), then
2. resolves the waiter **keyed by run id**.

So a workflow step waiting on a run wakes because *the run finished* — not because a particular
listener won a race. Fire-and-watch callers (the orchestrator) just read the projection; nobody is
starved. This is the structural fix for the stall.

---

## 7. Signals & notifications — one door each

- **Detect done/ready/pause:** positive receipt (§4). Timeouts are typed-failure backstops only.
- **Tell a human / orchestrator:** the durable **mailbox** (survives an offline recipient; drains on
  next liveness).
- **Push to the live UI:** one **relay** tailing the event log.
- **Wake a waiting workflow step:** the run-keyed waiter the reconciler resolves (§6).

---

## 8. What this buys

- No listener races; no stranded spawning/paused runs; no dual paths.
- Dev and packaged are the **same tree** — no mode-specific ownership.
- The Brain reloads freely; work survives. The Engine crashing fails-with-reason and re-runs from
  durable intent.
- Every "is it done?" has exactly one answer from one authority.

---

## 9. Migration — current tree → target tree

### Where we are (compressed)
- **Ownership of `claude.exe` is split:** the Engine (agent host) owns dispatched agents; the Brain
  (API server, via `ProjectRuntime`→`PtySession`) owns the orchestrator + modals. ⇒ 4 lifecycle state
  machines, 2 ready-detectors, 2 transcript readers.
- **"Alive/done?" is answered ~6 ways** (per-run timers, boot reconcile, continuous sweep, liveness
  sweep, host timers, envelope replay) — uncoordinated; they race and leave gaps.
- **Dev vs packaged disagree structurally:** dev = `dev-supervisor.mjs` over a separate API + host +
  Vite; packaged = Electron `main.ts` hosting the API in-process and spawning the host (which it does
  NOT respawn on death).

### Ordered moves (each independently shippable; risky moves after their prereqs)

**Step 1 — One reconciler + run-keyed waiter.** *(also the live stall fix)*
Collapse the racing terminal listeners + sweeps into the single control loop (§5) and the run-keyed
waiter (§6). Delete the redundant per-run listener. Smallest move that bends today's system toward the
target; it is the seam everything else hangs off. (The `complete-run` host relay already drafted is
part of this — the Engine's positive `done` for host-owned runs.)

**Step 2 — One reconciler covers ALL states.** Fold boot + sweep + liveness into Step 1's loop; give
spawning + paused an in-flight terminal path; never act on an unreachable/empty Engine snapshot. Kills
the analysis-doc's worst bug (reattach killing live runs).

**Step 3 — Engine endpoint re-resolution + reattach.** The Brain must re-discover the Engine after a
respawn and reattach, not cache the boot endpoint. *Prereq for Steps 4–5.*

**Step 4 — Engine absorbs the orchestrator session.** Brain stops owning the orchestrator
`PtySession`; it asks the Engine to run it (policy `persistent, interactive, fire-and-watch`) and
consumes its events.

**Step 5 — Engine absorbs the transient modals.** Same move for agent-designer / workflow-creator /
setup-wizard (policy `ephemeral, streaming`). Retire `ProjectRuntime`-owned `PtySession`s.

**Step 6 — Converge the lifecycle primitive.** With every `claude.exe` on the Engine, delete the
duplicates: one state machine, one ready-detector (`ReadyGate`), one transcript reader. `AgentRun`
becomes the single primitive with policy flags; `PtySession` / `InteractiveSession` / the v1 tailer
are deleted.

**Step 7 — One supervisor.** Unify `dev-supervisor.mjs` + Electron `main.ts` supervision into one
module used by both modes; respawn ALL service processes (fixes packaged host never respawning).

**Step 8 — Retire inference** where a positive signal exists; keep timeouts only as typed-failure
backstops.

---

## 10. Risks & notes

- **Crash isolation is the shaping constraint.** Keep Supervisor ≠ Brain, and the Engine separate
  from the Brain. Don't regress it while unifying.
- **The orchestrator is interactive + long-lived + pausable + streaming.** Validate the policy-flag
  model on it before deleting `PtySession`.
- **Modals need live chat streaming + deterministic session ids** (prior bleed-through bugs).
- **Step ordering:** Steps 4–5 REQUIRE Step 3, or an Engine respawn silently severs the
  orchestrator/modals.
- **Don't preserve zombie `claude.exe` across an Engine restart.** Durability is the store's intent +
  re-dispatch, not orphaned PTYs (that path is fragile; principle 4).
- **MCP children stay per-session.** This design changes who owns the *parent* `claude.exe`, nothing
  about the per-session MCP model.

---

## 11. One-line summary

Five roles, one home each — **a dumb durable Supervisor, an Engine that owns every `claude.exe`, a
Brain that owns the truth and runs one reconciler, a Store that is the truth, and a UI that only
views** — so there is one lifecycle, one "done" signal, and one thing waking whoever's waiting.
