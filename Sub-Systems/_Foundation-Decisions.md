# Foundation Decisions

> **What this is:** the agreed conceptual decisions for the rebuild, each with its reasoning. This is
> the *law* the rebuild must honor — the spec. It's deliberately separate from:
> - **the subsystem docs** (what's true *today*, as-built), and
> - **`_Emerson's Notes.md`** files (Emerson's in-progress thinking per folder).
>
> A decision lands here only once we've talked it through. Until then it's a **proposal** and can
> change freely.

**Status legend:** 🟡 Proposed (under discussion) · 🟢 Locked (agreed; rebuild must honor) · ⚪ Open (raised, not yet discussed)

---

## FD-1 — Where tools live: catalog in code, selection in the DB

**Status:** 🟢 Locked — 2026-06-03 (Emerson: "we don't need a tool DB")

**The decision (proposed):**
- **Built-in tools** — the *catalog* (each tool's name, description, and inputs) stays defined **in
  code**, as the single source of truth. It is not moved into a database table.
- **Tool selection** — *which* tools a given pod is granted stays **in the database**, per pod (as it
  works today: a `tools` list on the agent row).
- **External tools** (Gmail, Slack, other MCP servers) — configured **in the database, per pod**
  (the existing `agent_mcp_servers` attachment), because their behavior lives on someone else's
  server, not in our code.

**Why:**
- A tool is two parts — a *description* (data) and a *behavior* (code that actually does the thing).
  The behavior **must** be code. So every tool requires code regardless.
- Because code is always required, a database catalog could only ever be *descriptions pointing at
  code that must already exist* — it wouldn't let you add a working tool without a code change.
- Splitting a tool's description (DB) from its behavior (code) creates **two sources of truth that
  can drift** — the exact "poison at the roots" pattern we're trying to eliminate. Keeping them
  together in code makes drift impossible.
- Tool *selection*, by contrast, is genuine configuration ("this agent may do these things") — that
  belongs in the DB, and already is.

**What this means concretely:**
- Adding a new built-in tool = a code change (write its behavior + add its catalog entry together).
- Giving an agent a tool = a data change (edit the pod's tool list) — no deploy.
- The catalog (code) remains the thing that validates a pod's selected tools at launch.
- This is a deliberate **hybrid**: our tools = code catalog; outside tools = DB-configured per pod.
  It half-exists today; the rebuild should make it intentional, not accidental.

**Sub-questions — resolved:**
1. ~~Per-customer / per-deploy tool toggling?~~ **No.** Confirmed not needed (local-first,
   single-user). This was the only thing that argued for a DB catalog — so catalog-in-code stands.
   (And note: turning tools on/off *per agent* is already a data change via the pod's tool list — no
   code release needed for that.)
2. **Reverse drift (a pod lists a tool that no longer exists in code):** default rule —
   **drop-it-and-warn at launch** (one stale entry must never brick a working agent) **+ flag it
   loudly at edit/save time** so it's caught immediately. Revisit only if this proves too quiet.
3. **External tool servers (Gmail/Slack/etc.):** **not a near-term priority** — built-in tools only
   for now. But *design the seam* so an external server can register its tool list cleanly later
   (cheap to leave room for, expensive to retrofit). No integrations built until asked.

---

## FD-2 — One shared tools server vs. one messenger per agent

**Status:** ⚪ Open — needs a spike before deciding — 2026-06-03

**The idea (Emerson):** instead of every Claude process getting its own little tools-messenger,
have **one shared PC-RIG tools server** that all Claude processes connect to.

**The target this points at:** fold today's thin per-session messenger into the Brain as **one
always-on tools endpoint.** Every tool call already funnels to the one Brain over HTTP anyway — the
per-session messenger is just a stateless relay in front of it. Removing it deletes one process per
agent and a recurring "agent sees no tools on turn 1" timing bug.

**⚠️ The transport wrinkle (why this isn't free):**
- A *shared* server that many Claude processes connect to **must be served over HTTP (a URL)** — not
  stdio. **stdio can't be shared:** it's a private pipe between one parent (a Claude process) and one
  child, so it's inherently one-per-agent. "One server over stdio that everyone connects to" isn't
  possible; "one server over HTTP that everyone connects to" is.
- So the real question is: **does `claude.exe` reliably use an HTTP tools server?** This codebase has
  been burned repeatedly by Claude Code's quirks, so we do NOT assume it works — we test it.

**The spike (de-risk before committing):**
- Point a Claude process at a single HTTP PC-RIG endpoint (instead of spawning the stdio child) and
  confirm it connects and lists all tools.
- **Identity:** prove the shared server can tell *which* agent/run/project is calling (today identity
  is stamped into each per-agent messenger at spawn; over a shared HTTP server it must arrive some
  other way — a header, or a per-session token/path). This is the make-or-break item.
- **Timing:** check whether the 1–3s tool-registration lag disappears with an always-on server.
- **Concurrency:** several agents on the one endpoint at once — no cross-talk, no collisions.
- **Resilience:** Brain restarts — connected agents recover at least as well as today.
- **Success =** unambiguous per-call identity + reliable/fast tool registration + clean concurrency +
  survives a restart.

**Note:** the current north-star doc says "keep the per-session MCP child" — but it says that for
*ownership* reasons, not efficiency. This FD is a deliberate challenge to that on efficiency grounds;
if the spike succeeds, the north-star note gets updated.

**Scope note (2026-06-03):** the per-orchestrator *channel child* was briefly in scope here; its
fate is now decided independently by **FD-3** (it dies, regardless of this spike's outcome). FD-2's
spike is solely about the **tools** transport.

---

## FD-3 — The channel notification system dies entirely; the mailbox is the ONE notify door

**Status:** 🟢 Locked — 2026-06-03 (Emerson: "entirely dead and no piece of it must survive")

**The decision:**
- The **entire channel notification path is removed** in the rebuild. Nothing survives:
  - the per-orchestrator channel child (`channel-server/server.js` and its `.mcp.json` entry),
  - the `--dangerously-load-development-channels` spawn flag and the regex-matched auto-confirm of
    Claude's dev-channel boot prompt,
  - channel MCP push notifications into the orchestrator,
  - the `channel-event` direct-to-UI broadcast (the relay bypass),
  - and the config-filtering machinery that existed only to keep the webhook server entry from
    knocking out dispatched agents' tools.
- **All notifications to the orchestrator flow through the durable mailbox**, delivered by injecting
  a turn into the orchestrator's PTY (the existing mailbox → orchestrator-turn path becomes the only
  path).

**Requirements on injected notifications (Emerson, part of the decision):**
1. **Clearly labeled as system messages** in the injected text itself — the orchestrator (and anyone
   reading the transcript) can always tell a system notification from a human message. Never
   ambiguous.
2. **Tagged with a machine-readable source/kind end-to-end** (send-queue row → transcript → live
   events), so the frontend chat can **filter them out** (e.g. a "hide system messages" toggle).
   *(Partial support exists: runtime turns already carry a `source` field in the send-queue contract
   — the rebuild must carry that tag all the way through to the chat renderer.)*

**Why:**
- The channel path was a production feature standing on a **dev-mode escape hatch**: a
  `--dangerously-*` flag, an auto-confirmed boot prompt matched by regex (already broke once when CC
  changed banner rendering), and defensive filtering in the agent spawn path to contain it.
- It was also a **second notify door** beside the mailbox — the exact dual-path pattern this rebuild
  exists to kill. The mailbox does the same job durably, with zero claude.exe-quirk dependencies.

**Boundary question — resolved (Emerson, 2026-06-03): no outside hooks at all.** Inbound
external-webhook ingestion is **dropped entirely** — the rebuild has no webhook endpoint, no
channel server process, nothing. The channel system is 100% dead including its front door. If a
real integration ever needs inbound events, it comes back as a plain mailbox writer (one HTTP
endpoint that enqueues a mailbox message) — trivial to add when actually needed.

---

## Decision backlog (raised in discussion, not yet written up)

These came up and need their own entries once we talk them through:

- ⚪ **Work Item vs Work Contract model** — what each is, how they relate (goal vs. assignment), and
  the rule for a contract with no work item. *(See `0-store/contracts-system.md` and `3-product/work-items.md`.)*
- ⚪ **Where the deliverable lives** — proposed: the result lives on the Work Contract; the work item's
  `body` goes back to being the human description only. Kills the "result stored in two places" split.
- ⚪ **Store: event-log vs row-state** — the biggest one. Do we keep mutable rows, or move to an
  append-only event log with the current picture rebuilt from it? *(See `0-store/store-db.md`.)*
- 🟢 **Naming: "Work Contract"** — agreed 2026-06-03; in prose we call the `agent_contracts` entity the
  "Work Contract" to avoid collision with the `@pc/contracts` type package. (Code rename deferred to
  the rebuild.)
