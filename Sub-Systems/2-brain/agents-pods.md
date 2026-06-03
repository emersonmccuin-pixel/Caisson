# Agents & Pods

> **Role:** Brain / Store (definition layer) — cross-cutting into Engine at spawn time
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `packages/domain/src/pod.ts`, `pod-defaults.ts`, `agent.ts`, `tool-catalog.ts`, `tool-registry.ts`
> `packages/db/src/schema.ts` (agents + four child tables), `repos/pods.ts`, `pod-audit.ts`, `pod-revision.ts`
> `packages/runtime/src/pod-materializer.ts`
> `apps/server/src/services/pod-spawn.ts`, `pod-seed-with-drift.ts`, `pod-drift.ts`, `stock-pod-seed.ts`, `pod-tool-catalog.ts`, `pod-variable-renderers.ts`, `pod-mcp-config.ts`, `pod-writer.ts`
> `apps/server/src/routes/pod-routes.ts`
> `apps/web/src/hooks/use-project-pods.ts`, `features/agents/`

## What it is (plain English)

A "pod" is the stored definition of an AI agent — its prompt, which tools it can call, what model and effort level to use, any reference documents ("knowledge"), secrets (env vars), and extra MCP server configs. Think of it as the agent's job description and toolbox, persisted in the database and rendered fresh into files on disk every time the agent is launched.

Stock pods are the nine built-in specialists (researcher, writer, reviewer, planner, extractor, code-writer, agent-designer, workflow-builder, caisson) seeded at boot. User-created pods are project-scoped by default; they can be promoted to global.

## What it's supposed to do (intent)

Own the durable configuration of every agent in the system: what it knows, what it can do, and how smart it is. Every spawn reads from this layer; the pod row is the source of truth and the materialized `.md` + `mcp.json` are disposable outputs derived from it.

## How it works today (as-built)

### Storage — five DB tables

All in `packages/db/src/schema.ts`:

- `agents` — one row per pod. Scalar settings: `name`, `scope` (`global`/`project`), `project_id`, `prompt`, `tools` (JSON array of slugs), `model`, `effort`, `max_turns`, `output_destination`, `description`, `origin` (`stock`/`user-created`), `dispatch_guidance`, `expected_output`, `rev` (monotonic write counter). Soft-delete via `deleted_at`. (`schema.ts:580`)
- `agent_knowledge` — reference docs attached to a pod (`schema.ts:644`). Hard-deleted.
- `agent_secrets` — env-var secrets, stored plaintext v1 (`schema.ts:676`). Values never returned over the wire.
- `agent_mcp_servers` — per-pod MCP server configs in the `.mcp.json` shape (`schema.ts:706`).
- `agent_audit` — append-only change log. Every mutation writes a row in the same transaction. Secrets log event-only (value columns null). (`schema.ts:736`)

Domain types live in `packages/domain/src/pod.ts`: `PodAgentRow`, `PodKnowledgeRow`, `PodSecretRow`, `PodMcpServerRow`, `PodSpawnBundle`, `PodAuditRow`.

### Repository layer (`packages/db/src/repos/pods.ts`)

- `createAgent` / `updateAgent` / `softDeleteAgent` / `restoreAgent` — CRUD on `agents`. Every write is wrapped in a transaction that also inserts into `agent_audit`. `updateAgent` merges required contract tools (`mergeRequiredAgentTools`) so the DB always carries the correct set even after a hand-edit attempt.
- `promoteAgentToGlobal` — flips `scope='global'`, clears `project_id`. Audited as `field='scope'`. (`repos/pods.ts:374`)
- `cloneAgentToProject` — deep-copies an agent (scalars + knowledge + MCP rows, NOT secrets) into a target project as a `user-created` scope-project row. (`repos/pods.ts:428`)
- `isProjectDispatchable(agent)` — the single dispatch policy: a pod is visible/usable in a project if `scope==='project'` (for that project) OR `origin==='stock'` (built-in global). Global user-created pods are NOT auto-discoverable; the user must clone them. (`repos/pods.ts:1084`)
- `listProjectVisibleAgents(projectId)` — applies `isProjectDispatchable`; used by the orchestrator's `{{AVAILABLE_AGENTS}}` variable and the Agents-tab list route. (`repos/pods.ts:1092`)
- `resolveAgentForDispatch(name, projectId)` — project-scope wins over same-name global. Introduced in Section 22.1. (`repos/pods.ts:1099`)
- `getPodForSpawn(name, projectId)` — assembles the full `PodSpawnBundle` (agent row + content tables) the materializer needs. (`repos/pods.ts:1121`)

### Stock pod seeding (`apps/server/src/services/stock-pod-seed.ts`)

Nine stock pods are seeded at server boot:
- `STOCK_POD_CONTENT` array holds the `CreateAgentInput` for all nine non-orchestrator pods (prompts are inline constants). (`stock-pod-seed.ts:1038+`)
- Seeding uses `seedPodWithDriftReseed` (below) — insert if missing, auto-reseed if the row drifted and has no user-authored audit rows, skip if the user edited it.
- The caisson pod ships with five knowledge docs (product model, navigation, config cookbook, workflows guide, agents guide, troubleshooting) seeded via `createKnowledge` / `updateKnowledge`. (`stock-pod-seed.ts:398`)
- Orchestrator pod is seeded separately via `orchestrator-pod-seed.ts` / `orchestrator-pod-content.ts`.

### Drift detection (`apps/server/src/services/pod-seed-with-drift.ts` + `pod-drift.ts`)

`seedPodWithDriftReseed` is the trust model for stock pods:
1. If the row is missing — insert it.
2. If the row drifted from canonical (`collectDriftedFields` compares `SEED_OWNED_FIELDS`: prompt, tools, model, effort, maxTurns, outputDestination, description, dispatchGuidance) AND no user-authored audit row exists — auto-reseed the drifted fields.
3. If a user-authored audit row exists (`hasUserAuthoredEdit`) — skip and report. The user's customization is preserved.
4. "Reset to default" (UI button) writes reason `'ui-reset-to-default'`; the drift checker treats that as system-authored so future reseeds can resume.

`detectStockPodDrift(pod)` wraps the same logic for the UI — powers the "Customized" pill on stock rows in the Agents tab and the Specialists tab's "Reset all to default" action. (`pod-drift.ts:43`)

### Tool catalog (`packages/domain/src/tool-catalog.ts` + `tool-registry.ts`)

Two layers, now unified:
- `PC_RIG_TOOL_REGISTRY` in `tool-registry.ts` is **the single source of truth** for all pc-rig tools: name, description, catalogDescription, inputSchema, family. Added in Slice 016. (`tool-registry.ts:52`)
- `TOOL_CATALOG` in `tool-catalog.ts` is built by mapping over `PC_RIG_TOOL_REGISTRY` for the `pc-rig` partition, then appending hand-authored CC built-in entries (Read, Glob, Grep, Edit, Write, Bash, Task, WebFetch, WebSearch, AskUserQuestion). (`tool-catalog.ts:104,111`)
- `REQUIRED_AGENT_TOOLS` — four tools every dispatched agent always has: `pc_get_work_item`, `pc_submit_deliverable`, `pc_ask_user`, `pc_ask_orchestrator`. Enforced at three layers: (1) `createAgent`/`updateAgent` union-merge them into the DB row, (2) `materializePod` re-merges at spawn, (3) stock pod seeds list them explicitly. (`tool-catalog.ts:138`)
- `mergeRequiredAgentTools(tools)` — idempotent union. (`tool-catalog.ts:155`)
- `PC_RIG_TOOL_NAMES` is exported from `@pc/mcp` and re-exported by `pod-tool-catalog.ts` — the explicit name list used by the materializer's wildcard expander. (`apps/server/src/services/pod-tool-catalog.ts:13`)

### Materializer (`packages/runtime/src/pod-materializer.ts`)

Takes a `PodSpawnBundle` and writes two files:
1. `<pluginDir>/agents/<name>.md` — YAML frontmatter (name, description, tools comma-list, model, effort, maxTurns) + prompt body + optional "## Your contract" section (when a work item is linked) + optional "## Knowledge available" footer (when the pod has knowledge docs AND `pc_knowledge_read` is in its tool list) + "## Available tools" footer (when the prompt uses `{{AVAILABLE_TOOLS}}`).
2. A temp `mcp.json` — baseline MCP servers (the pc-rig server) merged with the pod's own `agent_mcp_servers` rows (pod wins per-name on conflict).

Wildcard expansion: `mcp__<server>__*` in the tools list is expanded to every explicit tool name from the supplied `mcpToolCatalog` before writing frontmatter. Unknown servers throw. (`pod-materializer.ts:428`)

`filterMcpToReferencedTools=true` (set for agent dispatches, not orchestrator spawns) strips unreferenced baseline servers (e.g. `webhook`) from mcp.json so CC's `--strict-mcp-config` doesn't drop all tools when a server fails to load. (`pod-materializer.ts:66`)

Two materializer functions:
- `materializePod` — writes to `<worktreeDir>/.claude/agents/<name>.md`.
- `materializePodPlugin` — writes to a session-local plugin dir and returns `--plugin-dir` + `--agent` CLI args. Production spawns use this path so agent definitions are isolated from the user's worktree. (`pod-materializer.ts:115`)

Variable substitution: `{{KEY}}` in the prompt body is replaced before writing. `AVAILABLE_TOOLS` is always injected (from the final expanded list). `AVAILABLE_AGENTS` is computed from DB at spawn time and injected when the prompt contains the placeholder. (`pod-variable-renderers.ts`, `pod-spawn.ts:113`)

### Spawn prep (`apps/server/src/services/pod-spawn.ts`)

`preparePodSpawn(input)` is the entry point the dispatch door calls:
1. `getPodForSpawn(agentName, projectId)` — fetches the bundle.
2. `prepareClaudeRuntimeFiles` — builds the baseline MCP config + settings file.
3. Checks for `{{AVAILABLE_AGENTS}}` and computes the rendered roster if needed.
4. Calls `materializePodPlugin(...)` with `PC_RIG_TOOL_NAMES` as the catalog for wildcard expansion.
5. Returns `{ mcpConfigPath, agentCliName, pluginDir, settingsPath, extraEnv, cleanup, podScope, podProjectId }`.

### HTTP routes (`apps/server/src/routes/pod-routes.ts`)

Mounted on the Hono app via `registerPodRoutes()`. CRUD on pods + content tables.

Post-mutation effects (two layers, in-txn):
- `announcePod(...)` — writes a `pod.changed` `live_outbox` row in-transaction. Global pods get a global frame (reaches all project sockets); project pods get a project frame. The relay drains it post-commit. (`pod-writer.ts`)
- `deps.onPodChanged?.(name, change)` — optional restart-on-edit hook; production wires agent-run-manager + project-runtime kill+respawn. (`pod-routes.ts:80`)

Stock pod guard: routes that delete or edit a pod with `origin='stock'` return 409/403. The `origin` column is the authoritative stock-pod identifier (introduced Section 36; replaced the multi-list pattern).

`GET /api/agents/pods?projectId=<ulid>` — returns `listProjectVisibleAgents(projectId)` with a `driftedFields` annotation on each pod (from `detectStockPodDrift`). Without `projectId`, returns global pods only.

`POST /api/agents/pods/:id/promote-to-global` — calls `promoteAgentToGlobal`.

`POST /api/agents/pods/:sourceId/clone-to-project` — calls `cloneAgentToProject`.

### UI (`apps/web/src/hooks/use-project-pods.ts` + `features/agents/`)

`useProjectPods(project, events)` — drives a `useResourceList` hook against `agentsApi.listPods(projectId)`. Triggers a wholesale refetch on any `pod.changed` live event (via `useLiveEntitySignature`). No in-memory patch: the list endpoint is the source of truth.

Pod mutations are delivered over WS via the `live_outbox` relay, not raw-broadcast.

## Integrations (how it connects)

- **Depends on:**
  - `@pc/db` (`agents` + four content tables, `agent_audit`, `live_outbox`) — the persistent store.
  - `@pc/domain` (`PC_RIG_TOOL_REGISTRY`, `TOOL_CATALOG`, `REQUIRED_AGENT_TOOLS`, pod types) — the type + catalog layer.
  - `@pc/runtime` (`materializePodPlugin`) — the file-writing step.
  - `@pc/mcp` (`PC_RIG_TOOL_NAMES`) — the explicit tool-name list for wildcard expansion.

- **Used by:**
  - Agent dispatch door (`agent-run-factory.ts` → `preparePodSpawn`) — every dispatched agent run reads through here.
  - Orchestrator spawn (`project-runtime.ts`) — materializes the orchestrator pod at boot.
  - Orchestrator prompt (`{{AVAILABLE_AGENTS}}`) — `pod-variable-renderers.ts:renderAvailableAgents` provides the roster.
  - PC-rig MCP tools `pc_create_agent`, `pc_update_agent`, `pc_get_agent`, `pc_list_agents`, `pc_delete_agent`, `pc_create_knowledge`, etc. — all route through `@pc/db` pod repos.

- **Contracts / events crossed:**
  - `pod.changed` live-outbox event — published in-transaction on every mutation; relay fans to project/global WS subscribers.
  - `PodSpawnBundle` — the read contract between the DB layer and the materializer.
  - `MaterializedPluginPod` — the output contract between the materializer and the spawn prep; carries `agentCliName`, `pluginDir`, `mcpConfigPath`, `envVars`.

## Target shape (per north star)

Pods are the **configuration layer** for the one session primitive (§3–4 of `unified-process-supervision-2026-06-02.md`). In the target: orchestrator, agent workers, and modals are the same primitive differentiated by a **policy record** on spawn. The pod supplies that policy: `prompt`, `tools`, `model`, `effort`, `maxTurns`, and the `filterMcpToReferencedTools` flag encode whether a session is persistent/interactive vs. one-shot/awaited vs. ephemeral.

No structural change required to the pod definition layer itself. The consolidation ledger (`consolidation-ledger-2026-06-02.md` §2, "Sources of truth") marks `PC_RIG_TOOL_REGISTRY → TOOLS/PC_RIG_TOOL_NAMES/catalog` as **DONE — single source** (Slice 016). The web `STOCK_POD_NAMES` mirror is **N/A — already gone**.

What does change: when Steps 4–6 (migrate orchestrator + modals to the Engine) land, `preparePodSpawn` becomes the one path for ALL session types, not just dispatched agents. The `filterMcpToReferencedTools` toggle already differentiates agent spawns (true) from orchestrator spawns (false) — that distinction is preserved and extended to modals (also true).

## Known issues / scar tissue

- **Secret storage is plaintext v1.** `agent_secrets.value_plaintext` is stored in SQLite with no encryption. The code comments note "v2 will swap to encrypted_value (DPAPI)." A UI warning banner is shown; the `buildEnvMap` function is the decrypt hook when encryption lands. (`pod-materializer.ts:417`, `pod.ts:143`)

- **`agent_inbox` tables still referenced by a hook.** `templates/.claude/hooks/inbox-drain.cjs` reads/writes the `agent_inbox` table via raw SQL (confirmed in ledger §0 re-verification). The TS repo for `agent_inbox` has zero callers, but the tables cannot be dropped until the hook is refactored to use the mailbox instead. This is tracked in ledger row #9 (`consolidation-ledger-2026-06-02.md:136`).

- **`listResolvedAgents` / `pc_list_agents` visibility gap (partially resolved).** The MCP tool `pc_list_agents` calls `listProjectVisibleAgents` which reads the DB directly — pod-aware. The older memory note about flat-file invisibility is stale for dispatch purposes: `resolveAgentForDispatch` has been DB-only since Section 22.1. However, the `agent-designer` pod's prompt still tells the designer to call `pc_create_agent` for new pods; there is no automatic sync back to flat files (the flat-file loader was removed in Section 17e). Any code path that formerly read `~/.project-companion/agents/*.md` is dead.

- **Tool wildcard throws on unknown server.** `expandToolWildcards` throws rather than silently ignoring an unknown server pattern. This is intentional ("loud failure beats a silent empty list") but means any pod whose tools list contains `mcp__<custom>__*` without a matching catalog entry will fail at spawn with an error, not a graceful degradation. (`pod-materializer.ts:444`)

- **Drift-reseed tool comparison needs `mergeRequiredAgentTools`.** Without the explicit merge in `collectDriftedFields`, every pod would false-positive a `tools` drift on every boot (seed lists don't include required tools explicitly; the DB row always does). The current code handles this correctly (`pod-seed-with-drift.ts:116`), but it's a subtle invariant that must be preserved when adding new `REQUIRED_AGENT_TOOLS`.

- **Secrets not cloned.** `cloneAgentToProject` deliberately excludes secrets ("sensitive and the cloning user may not intend to share them"). Any cloned pod requiring API-key env vars needs its secrets re-added manually. (`repos/pods.ts:428` comment)

## Open questions

- **DPAPI encryption for secrets.** When does v2 land? The `buildEnvMap` function is the right hook; the schema column rename (`value_plaintext` → `encrypted_value`) needs a migration.
- **`agent_inbox` hook refactor.** What's the timeline for migrating `inbox-drain.cjs` to the mailbox so the legacy tables can be dropped?
- **Project-scope pod overlay (Section 17c).** The schema already carries `scope` + `project_id` on content tables to support per-project knowledge/secret overlays on top of a global pod. `getPodForSpawn` reads a project pod's own content or a global pod's global content — it does NOT merge global + project content layers. The 17c overlay path (project-specific knowledge on top of a global pod) is described in comments but not implemented.
- **Wildcard expansion for custom MCP servers.** Today the only catalog entry for wildcard expansion is `'pc-rig': PC_RIG_TOOL_NAMES`. A pod with a custom MCP server (`pc_add_agent_mcp_server`) that wants `mcp__gmail__*` would need `gmail` added to the catalog at spawn time. There is no mechanism for that yet — the pod must list explicit tool names for custom servers.
