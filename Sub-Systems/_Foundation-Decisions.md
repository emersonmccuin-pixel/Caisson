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

## FD-4 — Agent scope: one three-tier field; `origin` dies

**Status:** 🟢 Locked — 2026-06-03 (from `2-brain/Emerson's Notes.md` discussion)

**The decision:**
- Scope becomes **one field with three values**:
  - **`built-in`** — ships with the app, available everywhere. Protected: can't be deleted, receives
    auto-updates unless customized (the existing drift/trust model keys off this value).
  - **`global`** — appears in every project's **"Add agent" picker**, but is *not* usable in a project
    until explicitly added. Not orchestrator-callable anywhere it hasn't been added.
  - **`project`** — lives in one project. **Promote to global** makes it *available* to other projects
    via the picker; the project-scoped original remains where it is.
- The separate **`origin` field is deleted** — "is this built-in?" *is* now a scope value, not a
  second axis to mentally combine with the first.

**Why:** today's behavior is already approximately this, but expressed as two fields (`scope` +
`origin`) whose combinations the reader must decode. One field, three values, no decoding.

**Deferred design (intent locked, mechanism later):** per-project *adjustment of a built-in* — tweak a
built-in agent for one project's specifics, with a visible "customized for this project" indicator.
The DB is already shaped for this overlay (Section 17c); the layering gets designed as its own small
piece, not in this pass.

---

## FD-5 — Assignment-level settings move to the Work Contract

**Status:** 🟢 Locked — 2026-06-03

**The decision:**
- **`expected_output` and `output_destination` come off the pod.** Both describe *an assignment*
  ("what does this job produce, where does the result go"), not *an agent*. The **Work Contract**
  owns them — set at dispatch, per job.
- **The deliverable result lives on the Work Contract** (absorbs the former backlog item). The work
  item's `body` goes back to being the human description only — kills the "result stored in two
  places" split (`work_items.body` doing double duty as `$root.output`).

**Why:** Emerson's instinct ("this should always be set at agent dispatch, no?") is exactly right —
pod-level defaults for job-level facts is how dispatch-time settings get silently overridden or
conflict. The contract becomes the *complete* job spec: what to produce, where it goes, who reviews it.

**Guard:** the `work_items.body` ↔ `$root.output` coupling is load-bearing today — the migration
needs the round-trip guard test the ledger already calls for before that write moves.

---

## FD-6 — One ask door: agents only ask the orchestrator

**Status:** 🟢 Locked — 2026-06-03

**The decision:**
- **Agents never ask the human directly. Every agent question goes to the orchestrator** through the
  mailbox; the orchestrator answers it itself or surfaces it to the human. `pc_ask_user` **dies**.
- The agent↔orchestrator exchange is **visible in chat by default**, with a chat-settings filter to
  hide system traffic. (No new mechanism — FD-3 already requires every injected system message to
  carry a machine-readable kind tag *exactly so* the chat can filter it. This also answers the
  mailbox doc's open question: system-injected messages are **shown by default**, filterable.)

**Why:** one door instead of two; the orchestrator is better positioned to triage than a raw agent
question landing in the human's lap; deletes a whole path.

**Ripple:** the **required-tools set changes** — `pc_ask_user` leaves the always-granted four. Fold
into the baseline-tools audit (see Audit backlog).

---

## FD-7 — Human Inbox System becomes its own workstream

**Status:** 🟢 Locked — 2026-06-03

**The decision:** human review gets designed as a **dedicated subsystem**, not patched per-feature:
- proper **review packages** (everything a reviewer needs, assembled),
- a proper **review process** (consistent approve/reject/feedback flow everywhere),
- **global notifications** when review is needed in *other* projects.

**What it must resolve (currently open questions it absorbs):**
- The two overlapping "open question" tables (`pending_asks_v2` vs `pending_interactions`) — the
  workstream picks ONE canonical durable inbox surface.
- Whether workflow review gates and contract verification holds **merge into one approval flow**
  (they are two mechanisms today; the asks-deliverables doc flags this).
- Where the loop-limit "agent failed 3 times, human needed" hand-offs land (FD-9).

---

## FD-8 — No message silently dies (mailbox lifecycle + failsafes)

**Status:** 🟢 Locked — 2026-06-03

**The decision:** the principle is law — **every undelivered or unanswered mailbox message must
either retry or surface visibly. Silent loss is never acceptable.** Concretely:
- **Dead-letter recovery:** a sweep re-delivers given-up orchestrator-turn messages when an
  orchestrator comes back online (today: 5 attempts, then silently gone — that's the bug this kills).
- **Lifecycle tracking:** sent → delivered → *expecting response* → response received → done. The
  plumbing half-exists (delivery rows track pending→accepted; interactions track open→answered); the
  rebuild unifies it and adds a **watchdog for "expecting a response that never came."**

**Why:** Emerson's failsafes note + the known issue that dead-lettered orchestrator copies vanish
with no alert, no indicator, no requeue.

---

## FD-9 — Workflow steps: Agent · Review · Move card · Loop

**Status:** 🟢 Locked — 2026-06-03 · ⚠️ **reverses the shipped card-move-as-effect decision**

**The decision:** the rebuild's step model is **four visible step kinds, each doing one thing**:
- **Agent** — hand a job to an agent (unchanged).
- **Review** — quality gate, human or orchestrator (unchanged).
- **Move card** — moving the card is **a step of its own**, drawn in the graph — not a property
  hidden under an agent or review step. The move-as-property mechanism **dies**, including
  "on reject, move back to Z."
- **Loop** — a real construct: review rejects → loop back to the agent step with feedback, up to a
  **retry ceiling (default 3)**; hitting the ceiling sends the work to the **Human Inbox** (FD-7).

**Why:** what the graph shows = what happens. A property is invisible in the editor; a step is drawn
and reviewable. The visual editor being genuinely good is a rebuild requirement — this serves it.
The old property's one job the step can't do (conditional move-back on reject) is covered better by
Loop semantics: the card only moves on the *forward* path, via explicit Move steps.

**One-path note:** this consciously reverses `card-move-as-effect` from the first-principles
redesign (shipped days earlier). The rebuild **deletes** the property path — no dual support.

---

## FD-10 — No stage-entry triggers

**Status:** 🟢 Locked — 2026-06-03

**The decision:** a card entering a stage **does not start a workflow**. Exactly two ways a run
starts: the **orchestrator's fire tool** and **manual "run now."** The stage-watching trigger
machinery is deleted in the rebuild.

**Why:** stage-entry triggering "causes too much issue" (Emerson) — it's a hidden tripwire that
fights the agent-centric direction. If automation demand returns, it comes back deliberately — most
likely as the orchestrator *noticing* the move and choosing to fire, keeping one brain in charge.

---

## FD-11 — Workflow observability + repair are core requirements

**Status:** 🟢 Locked — 2026-06-03

**The decision:**
1. **The run diary becomes the truth.** Every run keeps a readable step-by-step story (started step 2
   · agent delivered · review rejected with notes · retried…), and **the orchestrator can read all of
   it** to debug. A stuck or dead run is never a mystery. (This is the engine's flagged biggest gap —
   now fix-priority, and it interacts with the store event-log decision in the backlog.)
2. **Restart at a specific step** after repair — not from scratch.
3. **Repair loop until reliable:** broken workflow → orchestrator helps work through it → resume from
   the failed step → once it succeeds, it's locked in as the repeatable, reliable workflow.
4. **The workflow-builder agent must be expert-level** — complete knowledge of how the engine works,
   translating user intent into a fully valid, runnable workflow ("saved ⇒ runnable" validation
   backstops it).

---

## FD-12 — One write door, zero bypasses

**Status:** 🟢 Locked — 2026-06-03 (from `0-store/Emerson's Notes.md` discussion)

**The decision:** the gateway law becomes enforced, not aspirational — **every durable change goes
through the one write door, with the change and its "this changed" receipt written in one
unbreakable step. Zero bypasses.**

**The three known bypasses, all sentenced:**
1. ☠ The old two-step work-item writer (`work-item-writer.ts` — save, then announce separately) —
   cut in favor of the one-step gateway form that already exists.
2. ☠ The workflow run-diary writes that skip the gateway and `live_outbox` (`appendEvent`) — routed
   through the door when the diary becomes truth (FD-11 / FD-13).
3. ☠ The legacy `inbox-drain.cjs` hook's raw-SQL writes — dies with the mailbox migration
   (ledger row 9).

**Plus a guard:** a structural test that a new bypass can't quietly appear (e.g., no direct
table-write imports outside the gateway layer). Vigilance is not a strategy; the build enforces it.

**Why:** Emerson's "poison at the roots rots the whole tree." The one-cashier-window pattern is
already the design; this locks closing the stragglers as rebuild requirements.

---

## FD-13 — The store split: happenings are event logs, configuration is rows

**Status:** 🟢 Locked — 2026-06-03 — **the #1 store decision, resolved**

**The decision:** a deliberate split, not all-or-nothing event-sourcing:
- **Things that happen** — workflow runs, agent runs, messages/notifications — are stored as
  **append-only event logs** (the diary is the truth; "current state" is derived from it).
- **Things that are configured** — agents/pods, projects, settings, cards, stages — stay as
  **mutable rows** (with the existing append-only audit tables for history).

**What this buys (user-visible):** a frozen or dead run is never a mystery · any run's history can
be replayed step-by-step · the orchestrator's debugging view (FD-11) becomes trivially real.

**Why the split and not full event-sourcing:** history is the whole *value* of run-shaped data —
you ask "what went wrong?" about runs, not about a pod's prompt. Event-sourcing config would tax
every screen in the app for no user-visible gain; the audit tables already keep config history.
All the payoff where it pays, none of the tax where it doesn't.

**Resolves:** the "Store: event-log vs row-state" backlog item. FD-11's run diary is the first
concrete instance. Open (technical): cutover handling for runs in flight when the diary becomes
truth (migrate history vs accept gap vs quiet-moment cutover).

---

## FD-14 — Interrupted runs are resumable; paused runs always survive restart

**Status:** 🟢 Locked — 2026-06-03 (from `1-engine/Emerson's Notes.md` discussion)

**The decision:**
1. **A run killed by an app/engine crash is resumable, not just visibly failed.** The conversation
   survives on disk (Claude's transcript file); the continuation machinery already exists. The
   product grows a **"resume interrupted job"** affordance instead of a dead-end failure notice.
2. **Paused runs (waiting on a human answer) always survive a restart** — already true on the
   production path; locked as law everywhere (the legacy boot path that bulk-fails paused runs is
   wrong and dies in the Step-2 one-loop merge).

**Why:** "I don't want users losing valuable work because they accidentally closed the app"
(Emerson). The work isn't lost today — we just don't offer the pickup.

---

## FD-15 — Agent concurrency cap is a visible app setting

**Status:** 🟢 Locked — 2026-06-03

**The decision:** the "how many agents may run at once" limit (hard-coded 5 today; the rest queue)
becomes a **global app setting** the user can see and change.

---

## FD-16 — Orchestrator tooling is two-tier: lifecycle first-order, diagnostics on demand

**Status:** 🟢 Locked — 2026-06-03

**The decision:**
- **Agent-lifecycle tools are first-order** — the orchestrator natively knows them in its prompt:
  list my agents, inspect a run, cancel, resume/continue. (Partially exists.)
- **Diagnostic/engine tools are reachable on demand** — exposed through a search-style "find me the
  tool for X" tool rather than dumped into the prompt or load-time tool list. Applies to the
  orchestrator and the `caisson` in-app specialist.

**Why:** Emerson wants debugging power available without prompt-bloat. The on-demand pattern is
proven (Claude Code itself uses deferred tool search for big catalogs).

---

## FD-17 — Timeouts escalate before they execute

**Status:** 🟢 Locked — 2026-06-03

**The decision:** **no agent is killed while demonstrably alive and working.** Silence is a trigger
for escalation, not execution. The ladder, in order:
1. "Looks slow" badge in the UI (exists today).
2. Verify the process is actually alive and mid-task (process check + transcript activity).
3. Notify the orchestrator to look in on it.
4. Kill **only** on the hard ceilings: total-run-time limit, or a confirmed-dead process.

Every escalation step is still typed and visible — this does not reintroduce silent hangs. The
blunt "5 minutes of quiet = killed as idle" behavior dies: it guesses death from silence, which
violates the positive-receipt principle, burns usage, and destroys user trust by killing
deep-in-work agents.

---

## FD-18 — "Claude is loading" is visible on every session surface

**Status:** 🟢 Locked — 2026-06-03

**The decision:** every chat surface (orchestrator especially, plus modals and agent views) shows a
clear loading state — greyed-out input + a "Claude is loading…" indicator — until the session's
**positive ready signal** fires, and only then enables input.

**The mechanism already exists:** the modern spawn path's ready gate waits for three positive
confirmations (tools registered + input channel open + init complete) — not just the welcome
banner. The rebuild requirement is *surfacing* it. The three popup modals get this for free when
they migrate off the older banner-guess machinery (Engine Steps 5–6).

**Why:** feedback to the user is non-negotiable; "is it frozen or loading?" must never be a guess.

---

## Audit backlog (agreed work, not decisions)

- **Knowledge usage audit** — is attached knowledge actually *used* by agents, or just listed in a
  footer? Dispatch agents with knowledge attached, read transcripts, verify they reach for
  `pc_knowledge_read` when relevant. Nobody has checked.
- **Agent-management toolkit audit** — FD requirement: one built-in, orchestrator-callable agent with
  the *complete* agent-management toolkit (apply knowledge, secrets, tools, MCP servers…). Verify
  what's tool-doable today vs UI-only; close the gaps.
- **Baseline-tools audit** — re-derive the always-granted tool set EVERY agent gets (changes under
  FD-6: `pc_ask_user` leaves). Then the full agent roster audit (tools, descriptions, dispatch
  guidance) — deliberately *after* the rebuild's bigger pieces settle.

---

## Decision backlog (raised in discussion, not yet written up)

These came up and need their own entries once we talk them through:

- ⚪ **Work Item vs Work Contract model** — what each is, how they relate (goal vs. assignment), and
  the rule for a contract with no work item. *(See `0-store/contracts-system.md` and `3-product/work-items.md`.)*
  Also owns: **passing work down the line** in workflows (hand-off control lives in the contract) —
  parked here per the 2026-06-03 discussion.
- 🟢 **Naming: "Work Contract"** — agreed 2026-06-03; in prose we call the `agent_contracts` entity the
  "Work Contract" to avoid collision with the `@pc/contracts` type package. (Code rename deferred to
  the rebuild.)

*(Resolved and promoted: "Where the deliverable lives" → FD-5 · "Store: event-log vs row-state" → FD-13.)*
