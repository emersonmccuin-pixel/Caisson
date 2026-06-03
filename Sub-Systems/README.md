# Caisson — Master Subsystems List

> **Purpose:** one map of every subsystem in the current app, so we can bring each one into a clean
> rebuild deliberately — understanding its intent, then building it right in the unified architecture.
> **Snapshot date:** 2026-06-03. **Source branch:** `refactor/auto-pathway`.
> Each row links to a full doc in this folder. Format defined in `_TEMPLATE.md`.

> **Decisions live in [`_Foundation-Decisions.md`](_Foundation-Decisions.md)** — the agreed conceptual
> calls for the rebuild (proposals until we lock them). That's the spec; these subsystem docs are the
> as-built facts.

## How to read this

- **Role** = which of the five north-star roles it belongs to (Supervisor · Engine · Brain · Store · UI),
  or *cross-cutting*. The target architecture is in `refactor plan/unified-process-supervision-2026-06-02.md`.
- **Verdict** = keep / merge / rebuild / delete, per the consolidation ledger + the north star.
- **Biggest issue** = the one thing most worth knowing before you rebuild it.

The big theme across everything: the app *works*, but the same job is often done two ways (a "dual
path"). The unified design says **one job, one owner, one path**. Most issues below are a flavor of that.

---

## The 24 subsystems, grouped by role

### Store — "the truth" (durable state lives here)

| Subsystem | What it is | Verdict | Biggest issue |
|---|---|---|---|
| [Store / Database](0-store/store-db.md) | SQLite: all tables, migrations, ULID ids, the repo layer | **keep + evolve** | Mostly *row-state*, not the append-only *event log* the north star wants. Only `live_outbox`, `*_audit`, `work_items.history` are truly append-only. Closing this gap is the biggest single rebuild decision. |
| [App-services layer](0-store/app-services-layer.md) | Portable write layer (gateway+adapter) between raw DB and HTTP | **keep + finish extraction** | Two "announce" forms coexist; the old `work-item-writer` writes the row and the live-event in *separate* transactions (can drop a notification). The newer gateway does both atomically — finish moving to it. |
| [Contracts (typed boundary)](0-store/contracts-system.md) | Shared TS types/schemas at every seam (also the "Work Contract" entity) | **keep** | The v2 deliverable type union is duplicated (browser-safe mirror) with **no drift guard** — change one, the other silently diverges. |

### Engine — the single owner of every `claude.exe`

| Subsystem | What it is | Verdict | Biggest issue |
|---|---|---|---|
| [Agent Host (Engine)](1-engine/agent-host-engine.md) | Separate process that owns dispatched agent workers; HTTP API the Brain calls | **keep + expand scope** | Today owns *only* dispatched agents. North star (Steps 4–6) makes it own the orchestrator + modals too — collapsing 4 lifecycles → 1. |
| [Runtime — PTY & session primitives](1-engine/runtime-pty-sessions.md) | Low-level machinery to spawn/talk-to/read a `claude.exe` over a PTY | **rebuild → one primitive** | Three session wrappers exist; `PtySession` detects "ready" from the banner, not MCP, so input is sent before tools bind. All collapse to one policy-driven primitive in Step 6. |
| [Agent run lifecycle & reconciler](1-engine/agent-run-lifecycle.md) | Create/track/keep-alive/finalize a run; answers "is it alive/done?" | **rebuild → one reconciler** | The stall lived here. Step 1 (one terminal authority + run-keyed waiter) is **fixed in code**. Step 2 remains: 3 separate sweeps still answer alive/done with no shared "hold when Engine unreachable" rule. |
| [Transcript tailers & replay](1-engine/transcript-tailers.md) | Reads Claude's on-disk JSONL to render chat (and, historically, infer "done") | **keep for chat; never for done** | Inferring completion by tailing was the stall's root cause. Positive receipt (`pc_submit_deliverable`) now signals done; keep tailing only for rendering. |

### Brain — the control plane (owns the truth, runs one reconciler)

| Subsystem | What it is | Verdict | Biggest issue |
|---|---|---|---|
| [MCP (tools bridge)](2-brain/mcp.md) | Per-session "hands": typed tools that call back into the app | **keep** | `pc_node_failed` is a no-op stub — the only tool that still leans on inference (JSONL scrape) instead of a positive receipt. |
| [Agents & Pods](2-brain/agents-pods.md) | Stored agent definitions (prompt, tools, MCP scope, secrets, scope) | **keep + dedupe sources** | Tool catalog has multiple sources of truth (`TOOLS` vs `PC_RIG_TOOL_NAMES` vs a web mirror) that silently drift. Secrets are plaintext. |
| ↳ [Built-in Agents (catalog)](2-brain/built-in-agents.md) | The ten agents Caisson ships with: orchestrator + 9 specialists — who they are, what each is for | *(companion)* | Catalog, not a subsystem. See the agents-pods doc above for the system. |
| [Orchestrator](2-brain/orchestrator.md) | The persistent conversational Claude that is the user's chat | **rebuild → Engine-owned** | A separate lifecycle/ready-detector/reader from agents (the dual path the whole effort targets). Moves to the Engine in Step 4. |
| [Asks, deliverables & review](2-brain/asks-deliverables-review.md) | The explicit positive signals: ask-and-pause, submit-deliverable, human review | **keep — this is the backbone** | The deliverable fix once landed on the wrong path (in-process while host-backed stalled). Any "done" handling added outside the one terminal authority re-strands host runs. |
| [Mailbox & notifications](2-brain/mailbox-notifications.md) | Durable queue to notify a human/orchestrator even when offline | **keep** | A legacy hook (`inbox-drain.cjs`) still drains old `agent_inbox` tables via raw SQL — a parallel delivery path inside the orchestrator process. Blocks dropping those tables. |
| [Workflow engine (DAG)](2-brain/workflow-engine.md) | Chains steps; each step = agent + optional review gate; deliverable = done | **rebuild (in progress)** | `workflow_run_events` is written but bypasses the gateway and the UI discards it; the real store is a mutable `dag_state` JSON blob. "A frozen run is never a mystery" isn't delivered yet. |

### Product domains (what the user actually works with)

| Subsystem | What it is | Verdict | Biggest issue |
|---|---|---|---|
| [Work Items](3-product/work-items.md) | The unit of work: every card/task/job is one `work_items` row | **keep** | `wi.body` does double duty (human brief *and* agent deliverable) and a workflow reads it live for variable refs — load-bearing but undocumented, no guard test. |
| [Stages, Areas & Kanban](3-product/stages-areas-kanban.md) | Board columns; cards move between stages (stage-entry triggers ☠ FD-10; areas promoted per FD-19) | **keep** | Area soft-delete nulls members' `areaId` without per-item events; the board survives only via a full refetch on the delete frame — fragile in a race. |
| [Conversations & Chat](3-product/conversations-chat.md) | Durable conversation model + chat UI (a view over events) | **keep + delete legacy path** | The dual-stream render fix is in, but two render paths still coexist; the legacy one is "frozen baseline," not deleted — violates one-path. |
| [Files & Attachments](3-product/files-attachments.md) | Project file tree/preview + attachments stored inline in the DB | **keep** | Path containment uses `startsWith(root+sep)` (works, but one edit from the sibling-prefix hole); a dual-broadcast in `AttachmentService` is unscheduled debt. |

### UI shell — pure view + input (owns nothing, reattaches to the Brain)

| Subsystem | What it is | Verdict | Biggest issue |
|---|---|---|---|
| [Web UI shell](4-ui/web-ui-shell.md) | React frontend: shell/rails/tabs, client store, WS-driven live hooks, API client | **keep — already close to target** | Mostly clean. Lingering: a dead `_events` param on `useResourceList`; workflow-run events written to DB but discarded by the UI until they route through the relay. |
| [Transient sessions & modals](4-ui/transient-sessions-modals.md) | Short-lived chat modals: agent-designer, workflow-creator, setup-wizard | **☠ delete (FD-21)** | Modals die entirely — authoring flows through the orchestrator + dispatched specialists; Step 5 collapses into "delete." |

### Supervisor & operations — keep the processes alive

| Subsystem | What it is | Verdict | Biggest issue |
|---|---|---|---|
| [Supervisor](5-supervisor-ops/supervisor.md) | The dumb durable root: spawn → watch → respawn-with-backoff | **build + wire in** | The `@pc/supervisor` package is built + unit-tested but **not wired in**. Packaged mode still doesn't respawn the host. This is Step 7 — ready to build now, no prereqs. |
| [Desktop / Electron shell](5-supervisor-ops/desktop-electron.md) | Packaged Windows app: hosts the API in-process, spawns the host, serves the UI | **rebuild → thin shell** | The agent host is spawned once and **never respawned** (`main.ts:279` logs and stops). Dev and packaged are structurally different trees; Step 7 unifies them. |
| [Onboarding & setup](5-supervisor-ops/onboarding-setup.md) | First-run gate + project factory (preflight, auth, install, scaffold) | **keep** (setup-wizard modal ☠ FD-21; version pin → FD-22) | Self-contained and clean. Carries the same `inbox-drain.cjs` scaffold blocker. |
| [Dev controls & diagnostics](5-supervisor-ops/dev-controls-diagnostics.md) | Restart endpoint, process-control, crash capture, host-health pill | **keep dev-only; fold restart into Supervisor** | Restart-on-crash works in dev (`dev-supervisor.mjs`) but not packaged — the same gap Step 7 closes. |
| [Live events & relay](5-supervisor-ops/live-events-relay.md) | DB fact → all browser tabs: write `live_outbox` row in-txn, relay fans out over WS | **keep + finish migration** | Dual delivery still live for several domains (some code calls `broadcastTo()` directly alongside the relay). `workflow_run_events` bypasses the outbox entirely. |

---

## Cross-cutting issues (show up in many subsystems)

These are the systemic threads — fixing them once helps everywhere:

1. **Dual paths everywhere.** The orchestrator, modals, and agents each have their own lifecycle /
   ready-detector / transcript-reader. Collapsing to one Engine-owned primitive (Steps 4–6) is the
   single highest-leverage move.
2. **Inference vs positive receipt.** "Done" was guessed from log files; the fix is explicit signals
   (`pc_submit_deliverable`). Mostly landed; `pc_node_failed` and the workflow done-path are the
   stragglers.
3. **Row-state vs event-log.** The DB stores mutable rows; the north star wants an append-only event
   log with projections. `workflow_run_events` and `dag_state` are the clearest symptom (events
   written but ignored; the JSON blob is the real store).
4. **`inbox-drain.cjs` legacy hook.** A raw-SQL hook inside the orchestrator process drains old
   `agent_inbox` tables — a hidden parallel notify path. Blocks dropping those tables. Touches
   mailbox, agents-pods, and onboarding.
5. **Packaged mode never respawns the host.** Dev self-heals; the shipped app doesn't. Step 7
   (Supervisor) fixes it — and it's unblocked today.
6. **No drift guards on duplicated definitions.** Tool catalog (3 copies), the deliverable type union
   (2 copies), stock-pod name mirrors. Each silently breaks when one copy changes.

---

## Recommended bring-over order (for the rebuild)

Build bottom-up: nothing depends on something not yet built. Each tier is independently shippable.

**Tier 0 — Foundations** (everything sits on these; build first, get them clean)
1. **Store / Database** — decide event-log-vs-row-state *here*, before anything writes to it.
2. **Contracts** — the typed boundary every other package imports.
3. **App-services layer** — the one write surface (atomic row + live-event).

**Tier 1 — Process spine** (the five-role skeleton; this is where the north star's Steps 1–7 live)
4. **Supervisor** — dumb root first; everything else gets spawned under it. *(Step 7, no prereqs.)*
5. **Runtime — one session primitive** — the single policy-driven `claude.exe` wrapper.
6. **Agent Host (Engine)** — the one owner of that primitive.
7. **Agent run lifecycle & reconciler** — one reconciler + run-keyed waiter. *(Steps 1–3.)*
8. **Live events & relay** — projections out to the UI.
9. **Transcript tailers** — chat rendering only (never completion).

**Tier 2 — Control plane** (Brain logic, on top of the spine)
10. **MCP** — the agent's hands (the tools the primitive exposes).
11. **Agents & Pods** — the config that parameterizes a session.
12. **Asks, deliverables & review** — the positive signals the lifecycle is built on.
13. **Mailbox & notifications** — the one notify door.
14. **Orchestrator** — the first real session on the unified primitive. *(Step 4.)*
15. **Workflow engine** — chains sessions; depends on all of the above.

**Tier 3 — Product domains** (what the user touches)
16. **Work Items** → 17. **Stages / Areas / Kanban** → 18. **Conversations & Chat** →
19. **Files & Attachments**

**Tier 4 — Shells & experience** (thin views over a working Brain)
20. **Web UI shell** → 21. **Transient sessions & modals** *(Step 5)* →
22. **Desktop / Electron shell** *(Step 7)* → 23. **Onboarding & setup** →
24. **Dev controls & diagnostics**

> **Note on "new repo vs in place":** this order works either way. In a fresh repo it's a build
> sequence; in the current repo it's the same order as the north star's migration Steps 1–8. The
> open decision (Tier 0, item 1) — how far to go toward a true event-log store — is the one choice
> that most changes how much is "rebuild" vs "lift-and-clean." Worth settling before Tier 1.
