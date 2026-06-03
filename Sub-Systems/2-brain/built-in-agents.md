# Built-in Agents (the stock roster)

> **Role:** Brain (these are the agents the system ships with)
> **Status:** as-built snapshot — 2026-06-03
> **Companion doc:** [agents-pods.md](agents-pods.md) explains the *system* (how agents are defined,
> stored, seeded, kept from drifting). This doc is the *catalog* — who the built-in agents are.
> **Code anchors (the real source of truth):**
> - `apps/server/src/services/stock-pod-seed.ts` — the nine stock specialists (`STOCK_POD_CONTENT`)
> - `apps/server/src/services/workflow-builder-pod-content.ts` — the workflow-builder
> - `apps/server/src/services/orchestrator-pod-content.ts` — the orchestrator

## What this is (plain English)

Caisson ships with **ten built-in agents**. One is the **orchestrator** — the assistant you chat
with. The other nine are **specialists** the orchestrator can hand work to (or, for two of them, that
you open from a button in the UI). They're seeded into the database automatically every time the
server boots. You can customize them or add your own, but these are always there out of the box.

A quick vocabulary note for the table below:
- **Model:** `opus` = the most capable/careful; `sonnet` = faster, lighter.
- **Output goes to:** *chat* = it posts its result into the conversation; *passthrough* = it hands
  its raw result straight back to whatever called it (e.g. a workflow step).
- **Max turns:** how many back-and-forth steps it gets before it must wrap up (`—` = no fixed cap).
- Every dispatched worker *always* has four tools merged in: read its assignment
  (`pc_get_work_item`), submit its result (`pc_submit_deliverable`), and reach out
  (`pc_ask_user`, `pc_ask_orchestrator`).

## Quick reference

| Agent | What it's for | Model | Output | Max turns | How it's used |
|---|---|---|---|---|---|
| **orchestrator** | The project's PM — your single point of contact; dispatches the rest | opus | passthrough | — | You chat with it |
| **researcher** | Investigates: reads files anywhere, fetches from the web, summarizes what exists | opus | passthrough | — | Dispatched |
| **planner** | Breaks a goal into ordered, concrete, verifiable steps + risks | opus | chat | 15 | Dispatched |
| **writer** | Drafts prose — emails, docs, summaries, release notes — in the right voice | sonnet (med) | chat | 20 | Dispatched |
| **code-writer** | Writes/edits code to a spec; runs typecheck/tests/lint; returns only on green | sonnet (high) | chat | 30 | Dispatched |
| **reviewer** | Critiques a draft/code/plan against criteria; returns pass / fail / revise | sonnet (high) | chat | 20 | Dispatched |
| **extractor** | Pulls structured data (JSON to a schema) out of messy input | sonnet (med) | chat | 15 | Dispatched |
| **caisson** | In-app expert: explains how Caisson works *and* changes its config | sonnet (high) | chat | 25 | Dispatched |
| **agent-designer** | Builds a *new agent* with you through a short conversation | sonnet (med) | passthrough | 30 | UI button only |
| **workflow-builder** | Builds a *new workflow* with you through an interview | sonnet (high) | passthrough | — | UI button only |

## The agents in detail

### The one you talk to

**orchestrator** — *the project's PM.* Your single point of contact. It holds the conversation,
decides what needs doing, and dispatches the specialists below to do substantive work. It can also
make small fixes itself (read/edit/write files, run commands) and handle runtime recovery. It's the
only built-in that isn't "dispatched" — it's the top of the chain. Runs on opus.

### Worker specialists (the orchestrator hands these jobs)

**researcher** — investigates context on demand. Reads anywhere on the filesystem, fetches from the
web, and writes findings inside its work area. Use it for: one-off filesystem investigations,
multi-file reading, web lookups, "summarize what exists." Runs on opus.

**planner** — turns a goal into an ordered, concrete, verifiable list of steps, and surfaces
dependencies, risks, and unknowns. It sequences; it doesn't strategize, and it doesn't pad with
obvious steps. Read-only. Runs on opus.

**writer** — drafts text (emails, docs, summaries, release notes, prose), matched to the audience's
voice. Returns the draft inline; can attach long drafts to the work item.

**code-writer** — writes or edits code to meet a spec, matching the surrounding conventions. Runs
typecheck / tests / lint itself and only returns when they pass.

**reviewer** — critiques a draft, code change, plan, or design against *explicit criteria*. Returns
**pass / fail / revise** plus concrete comments with `file:line` citations. If the criteria are
vague, it says so rather than guessing.

**extractor** — pulls structured data out of unstructured input and returns JSON matching a schema
you give it per job. Flags ambiguous fields as `null` instead of guessing. Read-only.

**caisson** — the in-app product specialist. Two jobs: (1) explains how Caisson works (stages, work
items, agents, workflows), and (2) actually *changes* configuration — project settings, stages,
custom fields, `CLAUDE.md`, global app settings — and routes workflow authoring to the
workflow-builder. **Always asks for approval before destructive changes.** It doesn't write source
code.

### Conversational builders (you open these from the UI — not dispatched)

**agent-designer** — designs a brand-new agent *with* you through a short conversation, then creates
it. Opened from **Agents tab → + New agent → Conversational**. Note: the orchestrator should *not*
invoke this itself — if you ask for a new agent in chat, it points you to that button.

**workflow-builder** — designs a new workflow through a conversational interview, then publishes it
to the database. Opened from **Workflows tab → + New workflow**. Knows the v2 workflow model (agent +
review nodes, card-move on completion/approve, declared input ports wiring one step's output into the
next, the unified review gate, reject-only kick-back). Same rule: not orchestrator-dispatched.

## How it works (seeding & drift)

- All nine specialists live in `STOCK_POD_CONTENT` (`stock-pod-seed.ts:1288`); the orchestrator is
  seeded separately. Their prompts are written inline as constants in those files.
- On every server boot, `seedStockPods()` inserts any missing ones. If a stock agent's definition in
  the code has changed since last boot, a non-user-edited row is **auto-updated** to match; a row
  *you've* customized is left alone and the difference is reported (the "Customized" pill in the
  Agents tab). See [agents-pods.md](agents-pods.md) for the full drift model.
- The caisson agent also ships with knowledge docs (product model, navigation, config cookbook,
  workflows guide, agents guide, troubleshooting), seeded the same way.

## Target shape (per north star)

No structural change. These are *configurations* of the one session primitive — a prompt + a tool
set + policy flags (which model, how many turns, where output goes). In the unified design the Engine
runs the session and these definitions just parameterize it. The roster itself is a product decision,
not an architecture one.

## Known issues / scar tissue

- **`pc_node_failed` (a researcher tool) is a no-op stub** — it acknowledges but reports nothing back
  to the server, so a researcher's hard-failure signal currently leans on log inference, not a
  positive receipt. (See [mcp.md](mcp.md).)
- **Conversational pods carry unusable worker tools.** agent-designer (and the other passthrough
  conversational pods) get `pc_ask_user` / `pc_ask_orchestrator` force-merged in by the repo layer
  even though those hard-error in a conversational (non-dispatched) context. The prompt forbids them;
  the real fix is to exempt conversational pods from the required-tool merge (a noted future item,
  `stock-pod-seed.ts:1166`).

## Open questions

- Is "ten built-in agents" the right roster for the rebuild, or do some merge/split? (e.g. is
  `caisson` doing two jobs — explainer *and* config-mutator — that should be separate?)
- Should the two conversational builders (agent-designer, workflow-builder) be modeled as the same
  kind of thing, given they share the "open from a button, interview, then create" pattern?
