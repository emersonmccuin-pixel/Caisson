# Agents & Pods

> **Role:** Brain / Store (definition layer) — cross-cutting into Engine at spawn time
> **Status:** as-built snapshot — 2026-06-03
> **Catalog companion:** [built-in-agents.md](built-in-agents.md) lists the ten agents that ship in the box.
> **Code anchors:**
> `packages/domain/src/pod.ts`, `pod-defaults.ts`, `agent.ts`, `tool-catalog.ts`, `tool-registry.ts`
> `packages/db/src/schema.ts` (agents + four child tables), `repos/pods.ts`, `pod-audit.ts`, `pod-revision.ts`
> `packages/runtime/src/pod-materializer.ts`
> `apps/server/src/services/pod-spawn.ts`, `pod-seed-with-drift.ts`, `pod-drift.ts`, `stock-pod-seed.ts`, `pod-tool-catalog.ts`, `pod-variable-renderers.ts`, `pod-mcp-config.ts`, `pod-writer.ts`
> `apps/server/src/routes/pod-routes.ts`
> `apps/web/src/hooks/use-project-pods.ts`, `features/agents/`

---

## What it is (plain English)

A **"pod" is the saved definition of an AI agent** — everything that makes one agent different from
another. Think of it as the agent's **job description plus its toolbox**, stored in the database.

The agent itself doesn't permanently exist as a running thing. It's *born fresh* each time it's
needed: the system reads the pod from the database and writes out the files a Claude process needs to
start. When the job's done, those files are thrown away. The pod (the definition) is what lasts.

> **"Pod" vs "agent":** they're effectively the same thing in this codebase. "Agent" is the everyday
> word; "pod" is what the stored definition is called. (Historically the table is even named `agents`.)

---

## What it's supposed to do (intent)

Own the **durable configuration of every agent**: what it knows, what it's allowed to do, and how
capable it is. Every time an agent runs, it reads from here. The pod is the single source of truth;
the files written to disk to launch it are disposable copies.

---

## The parts (every component, plain English)

A pod is made of **one core record plus four kinds of attachment.**

### Part 1 — the core settings (the `agents` table row)

These are the dials that define the agent. (`schema.ts:580`)

| Component | Plain English | Example / values |
|---|---|---|
| **name** | The agent's handle — how the orchestrator refers to it | `writer`, `researcher` |
| **prompt** | The instructions: its job, personality, rules, how to behave. The heart of the agent | (a block of text) |
| **tools** | The list of things it's *allowed* to do — read files, run commands, call app functions | `Read`, `Bash`, `pc_submit_deliverable` |
| **model** | Which Claude "brain" it uses | `opus` (most capable) / `sonnet` (faster) |
| **effort** | How hard it thinks before answering | `low` / `medium` / `high` |
| **max_turns** | How many back-and-forth steps it gets before it must wrap up | a number, or empty = no cap |
| **output_destination** | Where its result goes when done. 🟢 *FD-5: moves to the Work Contract in the rebuild (job-level, not agent-level)* | `chat` (posts to the conversation) / `passthrough` (hands the raw result back to whatever called it) |
| **description** | A human-readable summary of what it does (shown in the UI) | "Drafts emails, docs, summaries…" |
| **dispatch_guidance** | A note that tells the *orchestrator* **when** to pick this agent | "use for drafting prose" |
| **expected_output** | What kind of result it's supposed to produce by default. 🟢 *FD-5: moves to the Work Contract in the rebuild* | (a description of the deliverable) |
| **scope** | Where the agent is available. 🟢 *FD-4: rebuild collapses scope+origin into one field: `built-in` / `global` / `project`* | `global` (everywhere) / `project` (one project only) |
| **project_id** | Which project it belongs to, if project-scoped | (a project id, or empty) |
| **origin** | Whether it's built-in or user-made. 🟢 *FD-4: dies in the rebuild (folded into scope)* | `stock` (ships with the app) / `user-created` |
| **rev** | A counter that ticks up on every change — used to detect edits | `1`, `2`, `3`… |
| **deleted_at** | A "deleted" marker. Deleting hides it rather than erasing it (a "soft delete") | empty = alive |

### Part 2 — the four attachments (one extra table each)

Beyond the core row, a pod can carry four kinds of attached data:

1. **Knowledge** (`agent_knowledge`) — **reference documents** the agent can read while it works.
   Background material, guides, examples. (For instance, the `caisson` agent ships with six knowledge
   docs explaining the product.) The agent can only actually read these if it has the
   `pc_knowledge_read` tool.
2. **Secrets** (`agent_secrets`) — **private values like API keys**, handed to the agent as
   environment variables when it launches. ⚠️ Stored as plain text today (see Known issues). Their
   values are never sent back out over the network.
3. **MCP servers** (`agent_mcp_servers`) — **extra tool servers** beyond the built-in ones. This is
   how a pod could get, say, Gmail or Slack tools — by pointing at an additional server.
4. **Audit log** (`agent_audit`) — a **permanent, append-only history** of every change ever made to
   the pod: who changed what, when, and why. Written in the same step as the change itself, so it
   can't get out of sync. (Secret *values* aren't logged — only the fact that a secret changed.)

> Together, fetching the core row + all four attachments is called a **`PodSpawnBundle`** — the
> complete package needed to launch the agent.

---

## How a pod lives — the lifecycle

### Where it's stored

All of the above is in SQLite (`packages/db/src/schema.ts`): one `agents` row + the four child tables
(`agent_knowledge`, `agent_secrets`, `agent_mcp_servers`, `agent_audit`). The database is the truth;
everything else is derived from it.

### Creating, editing, deleting (`repos/pods.ts`)

- **Create / edit / delete / restore** — standard operations on a pod. Every single write is wrapped
  together with an audit-log entry in one transaction, so the history is always complete.
- **A safety merge on edit:** whenever a pod is saved, the system force-adds four mandatory tools
  (below) back into its tool list — so even a hand-edit can't accidentally remove them.

### Scope — who can see and use a pod

This is the rule for *which agents show up in which project* (`isProjectDispatchable`,
`repos/pods.ts:1084`):

- A **project-scoped** pod is usable in *its own project*.
- A **stock** (built-in) pod is usable *everywhere*.
- A **user-created global** pod is **not** automatically available in projects — you have to **clone**
  it into the project first. (This prevents one person's custom agents from silently appearing in
  everyone's projects.)
- **Promote to global** flips a project pod to global. **Clone to project** copies a pod into a
  project (it copies the settings, knowledge, and MCP servers — but **not** secrets, on purpose).
- When two agents share a name, the **project version wins** over a global one.

> 🟢 **FD-4 (locked 2026-06-03):** the rebuild expresses this as **one scope field, three values**
> (`built-in` / `global` / `project`); `origin` dies. Promote-to-global keeps the project original.
> Per-project tweaks to a built-in (with a "customized here" indicator) — intent locked, overlay
> mechanism designed later.

### The built-in pods and "drift" (`stock-pod-seed.ts`, `pod-seed-with-drift.ts`)

The nine specialists (plus the orchestrator) are **re-seeded into the database every time the server
starts.** That raises a question: what if you've customized one? The system handles it with a
**trust model** (`seedPodWithDriftReseed`):

1. **Missing?** → insert it.
2. **Changed in the code since last boot, and you *haven't* touched it?** → quietly update it to the
   new built-in version (you get bug-fixes/improvements for free).
3. **You *have* edited it?** → leave your version alone, and just flag it as "Customized" in the UI.
4. **"Reset to default" button** → wipes your customization and lets the auto-updates resume.

"Drift" just means "this pod no longer matches its built-in definition." The check compares eight
fields (prompt, tools, model, effort, max turns, output destination, description, dispatch guidance).

### Tools — the catalog, the required four, and wildcards

- **The tool catalog** (`tool-registry.ts` + `tool-catalog.ts`) is the master list of every tool an
  agent could be given — both Caisson's own app tools (the `pc_…` ones) and Claude Code's built-ins
  (Read, Edit, Bash, etc.). There's now **one source of truth** for this list (it used to be
  duplicated in a few places — that was a recurring bug).
- **The required four** (`REQUIRED_AGENT_TOOLS`): every dispatched agent *always* gets four tools, no
  matter what — read its assignment (`pc_get_work_item`), submit its result
  (`pc_submit_deliverable`), and reach out (`pc_ask_user`, `pc_ask_orchestrator`). This is enforced in
  three places so it can't be lost. 🟢 *FD-6: `pc_ask_user` dies in the rebuild (agents only ask the
  orchestrator) — the required set gets re-derived in the baseline-tools audit.*
- **Wildcards:** a pod can list `mcp__pc-rig__*` to mean "all tools from this server." At launch that
  expands to the explicit list. If it names a server that doesn't exist, it **fails loudly** rather
  than silently giving the agent no tools.

### From stored definition to running agent (`pod-materializer.ts`, `pod-spawn.ts`)

This is the moment a pod becomes a live agent. The system takes the `PodSpawnBundle` and writes **two
files** Claude needs:

1. **An agent definition file** (`<name>.md`) — the agent's settings as a header (name, tools, model,
   etc.) plus the prompt text. It also bolts on extra sections when relevant: the agent's "contract"
   (its assignment) when a work item is linked, a "knowledge available" footer, and an "available
   tools" list.
2. **A tool-server config file** (`mcp.json`) — which tool servers to connect, built from the standard
   set plus the pod's own extra servers.

Two important touches at this stage:
- **Variable substitution:** placeholders in the prompt like `{{AVAILABLE_AGENTS}}` get filled in with
  live data (e.g. the current roster of agents) just before launch.
- **Trimming unused servers:** for dispatched agents, tool servers the agent doesn't actually use are
  stripped out, so that if one server fails to load it doesn't knock out *all* the agent's tools.

`preparePodSpawn` is the single entry point the dispatch system calls to do all of this and hand back
everything needed to start the process.

### How pods show up and update in the app (`pod-routes.ts`, `use-project-pods.ts`)

- The Agents tab lists the pods visible in the current project, each flagged if it's been customized.
- **Built-in pods are protected:** trying to delete or hard-edit a `stock` pod is refused by the
  server.
- **Edits can restart a running agent:** there's an optional hook so that editing a pod kills and
  respawns any affected running agent, so changes take effect.
- **Live updates:** every pod change writes a `pod.changed` notification through the normal live-event
  path, and the UI refetches the list when it sees one. (No shortcuts — the list endpoint is always
  the source of truth.)

---

## Integrations (how it connects)

- **Depends on:**
  - `@pc/db` (`agents` + four content tables, `agent_audit`, `live_outbox`) — the persistent store.
  - `@pc/domain` (the tool catalog, required-tools list, pod types) — the type + catalog layer.
  - `@pc/runtime` (the materializer) — the file-writing step.
  - `@pc/mcp` (the tool-name list) — used to expand wildcards.
- **Used by:**
  - The agent dispatch path — every dispatched agent reads its pod through here.
  - The orchestrator — materialized from its pod at boot; its prompt's `{{AVAILABLE_AGENTS}}` roster
    is computed from the pod list.
  - The app's agent tools (`pc_create_agent`, `pc_update_agent`, `pc_list_agents`, …) — all read/write
    pods through this layer.
- **Contracts / events crossed:**
  - `pod.changed` live event — fired on every change.
  - `PodSpawnBundle` — the package handed from the database layer to the materializer.

---

## Target shape (per north star)

Pods are the **configuration layer for the one session primitive** (§3–4 of
`unified-process-supervision-2026-06-02.md`). In the target design the orchestrator, agent workers,
and modals are all the *same* underlying thing, differentiated only by a **policy record** at launch —
and the pod is what supplies that policy (prompt, tools, model, effort, max turns, and the
trim-unused-servers flag that distinguishes a long-lived session from a one-shot job).

No structural change is needed to the pod layer itself; the tool-catalog single-source cleanup is
already **done**. What changes: once the orchestrator and modals move to the Engine (Steps 4–6),
`preparePodSpawn` becomes the **one launch path for every kind of session**, not just dispatched
agents.

---

## Known issues / scar tissue

- **Secrets are stored in plain text.** `agent_secrets` holds values unencrypted in the database. A UI
  warning is shown; encryption (DPAPI) is planned but not built. (`pod.ts:143`)
- ~~**A legacy hook still touches old `agent_inbox` tables.**~~ ✅ M4a (2026-06-04): hook + tables
  deleted (migration 0041 archive; ledger row #9 closed).
- **Wildcard tools fail hard on an unknown server.** Intentional ("loud failure beats a silent empty
  toolset"), but a pod listing `mcp__something-unknown__*` errors at launch instead of degrading
  gracefully.
- **A subtle drift-check invariant.** The drift comparison has to merge in the required tools first,
  or every pod would falsely look "changed" on every boot. Handled correctly today, but must be kept
  in mind when adding new required tools. (`pod-seed-with-drift.ts:116`)
- **Cloning doesn't copy secrets** — on purpose. A cloned pod that needs an API key must have it
  re-added by hand.

## Open questions

- **When does secret encryption land?** It needs a schema change + a migration.
- **`agent_inbox` hook refactor** — timeline to migrate it so the legacy tables can be dropped?
- **Per-project overlays (Section 17c).** The schema is *ready* for project-specific knowledge/secrets
  layered on top of a global pod, but the layering isn't implemented — today a pod uses either its own
  content or the global content, never a merge. 🟢 *FD-4 locks the intent (per-project tweak of a
  built-in, visibly flagged); the mechanism is the open part.*
- **Custom MCP server wildcards.** Today only the built-in `pc-rig` server supports `mcp__…__*`
  wildcard expansion. A pod with a custom server (e.g. Gmail) must list its tools explicitly.

**Audit items (agreed 2026-06-03 — see Foundation Decisions "Audit backlog"):** knowledge-usage audit
(is attached knowledge actually read?) · agent-management toolkit audit (one built-in agent with the
complete toolkit — verify tool coverage vs UI-only) · baseline-tools audit (re-derive the required set
after FD-6).
