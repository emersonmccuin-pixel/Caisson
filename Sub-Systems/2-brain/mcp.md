# MCP (tools bridge)

> **Role:** cross-cutting (adapter layer — sits between the Engine/Brain and every claude.exe)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `packages/mcp/src/server.ts`,
> `packages/mcp/src/tools/` (agent-runs, agents, context, handlers, project-config, retry, workflows, work-items),
> `packages/mcp/src/client/typed-client.ts`,
> `packages/domain/src/tool-registry.ts`,
> `apps/server/src/services/mcp-config-rewrite.ts`,
> `apps/server/src/services/pod-mcp-config.ts`,
> `apps/server/src/features/mcp-bridge/routes.ts`

## What it is (plain English)

Every Claude agent process gets its own private "toolbox" process (the MCP child) that Caisson starts alongside it. When the agent calls a tool — say, "create a work item" or "dispatch a sub-agent" — the toolbox receives that call and forwards it as a plain HTTP request to the main Caisson server. The server does the real work and sends back a result. The agent never talks to the database or the server directly; every interaction goes through these tools. The toolbox also fires a signal back to the server once the MCP handshake is complete (letting the server know tools are live), and writes a heartbeat file every 2 seconds so the server can tell whether the toolbox is still alive.

## What it's supposed to do (intent)

Give each agent exactly one typed interface to every app service — work items, agent runs, workflows, pods, project config — without the agent needing to know about HTTP routes, database schemas, or internal service internals. MCP is an adapter over shared contracts and services, not a separate product API (AGENTS.md system thesis). It is disposable per-session: it starts with the agent and dies with it; its state is nothing — the Brain and DB own truth.

## How it works today (as-built)

**Boot / wiring:**
- Caisson scaffolds a `.mcp.json` into every project directory, pointing at `packages/mcp/dist/server.mjs` (the built bundle). Claude Code picks this up and spawns the MCP child when it starts.
- `server.ts` is guarded by an entry-point check (`import.meta.url === ENTRY_URL`, line 181) so importing the module in tests or server runtime does NOT boot an MCP server or pin the event loop.
- At spawn the MCP child writes `data/projects/<projectId>/mcp-status.json` (pid, timestamp, tool list) and then updates it every 2 seconds as a heartbeat (`server.ts:73–114`).

**Handshake signal (Section 22):**
- When CC's MCP client completes the JSON-RPC `initialized` notification, `server.oninitialized` fires (`server.ts:132–155`). For dispatched-agent spawns (where `PC_AGENT_SESSION_ID` is set), it immediately POSTs `POST /api/internal/mcp-handshake` back to the Brain.
- `mcp-bridge/routes.ts:81–110` routes that signal to whichever owner holds the session: the `ActiveRunRegistry` (in-process dispatched agent), the agent host via `notify-mcp-handshake` command, or the project orchestrator. This is what lets `agent-run-manager` gate its warmup-send on the real handshake rather than the earlier banner-only `state:'ready'`.
- Orchestrator + modal spawns (where only `PC_SESSION_ID` is set) skip the handshake POST — they don't suffer the spawn-time race.

**Tool catalog — single source of truth:**
- All 52 tool definitions (name + inputSchema + description) live in `packages/domain/src/tool-registry.ts: PC_RIG_TOOL_REGISTRY` (line 52). This is the sole ordered source.
- `server.ts` derives `TOOLS` (the MCP ListTools response, line 47) and `PC_RIG_TOOL_NAMES` (the `mcp__pc-rig__*` slugs for server-side wildcard expansion, line 58) both by `.map()` over the registry. A Slice-016 parity test asserts these stay in sync with the handler map; a half-added tool fails the build.

**Tool families (52 tools total):**
- **work-item** — `pc_create_work_item`, `pc_create_agent_work_item`, `pc_resolve_work_item`, `pc_log_bug`, `pc_move_work_item`, `pc_update_work_item`, `pc_get_work_item`, `pc_list_work_items`, `pc_list_areas`, `pc_attach_to_work_item` — CRUD + move + attach on work items. Handler: `tools/work-items.ts`.
- **agent** — `pc_create_agent`, `pc_get_agent`, `pc_update_agent`, `pc_delete_agent`, `pc_list_agents`, `pc_create_knowledge`, `pc_update_knowledge`, `pc_delete_knowledge`, `pc_knowledge_read`, `pc_create_agent_secret`, `pc_delete_agent_secret`, `pc_add_agent_mcp_server`, `pc_delete_agent_mcp_server`, `pc_list_agent_audit` — pod CRUD + knowledge + secrets + per-pod MCP servers. Handler: `tools/agents.ts`.
- **agent-run** — `pc_invoke_agent`, `pc_continue_agent`, `pc_list_my_runs`, `pc_inspect_agent_run`, `pc_kill_agent_run`, `pc_ask_orchestrator`, `pc_ask_user`, `pc_request_approval`, `pc_answer_pending`, `pc_submit_deliverable` — dispatch/continuation, pause-and-ask, and the positive done-signal. Handler: `tools/agent-runs.ts`.
- **workflow** — `pc_save_workflow_draft`, `pc_read_workflow_draft`, `pc_publish_workflow`, `pc_list_workflows`, `pc_fire_workflow`, `pc_complete_node`, `pc_node_failed`, `pc_create_workflow`, `pc_update_workflow`, `pc_delete_workflow`, `pc_get_workflow` — workflow authoring and execution controls. Handler: `tools/workflows.ts`.
- **project** — `pc_write_claude_md`, `pc_list_stages`, `pc_list_field_schemas`, `pc_replace_stages`, `pc_replace_field_schemas` — project configuration. Handler: `tools/project-config.ts`.

**Dispatch chain:**
- `CallTool` hits `server.ts:161–169`. It looks up the tool name in `PC_RIG_HANDLERS` (a name→fn map in `handlers.ts:51`), falls back to `dispatchPcRigTool` (the ordered chain in `handlers.ts:30–46`). The chain runs: work-item → agent → workflow → project → agent-run; first non-null result wins.
- Every handler in the chain takes `(name, args, ctx: ToolContext)` and pattern-matches on `name` with a switch. Unknown names return `null` (pass-through) until the final handler throws.

**ToolContext (`tools/context.ts:137–195`):**
- Created once per process at startup. Captures env vars: `PC_PROJECT_ID`, `PC_AGENT_SESSION_ID`, `PC_SESSION_ID`, `PC_AGENT_RUN_ID`, `PC_AGENT_PARENT_WORK_ITEM_ID`, `PC_AGENT_INVOKE_DEPTH`, `PC_SERVER_PORT`.
- Exposes typed HTTP helpers (`postServer`, `getServer`, `putServer`, `patchServer`, `deleteServer`) over `node:http` to `127.0.0.1:PC_SERVER_PORT`.
- Wraps all calls in `withConnRetry` (`tools/retry.ts`): 5 attempts, exponential backoff 80ms–1s, retries on ECONNREFUSED/ECONNRESET/503. This lets a tool call survive a ~1s API restart window.
- Also carries a `TypedLocalhostClient` (`client/typed-client.ts`) that parses `@pc/contracts` DTO guards over responses for internal type safety, while always emitting raw `body` text back to the agent (byte-identical to the pre-typed-client behavior).
- Injects a `withRichLinkHint` helper that appends a system reminder prompting the agent to format work-item callsigns and file paths as clickable `pc://` markdown links.

**`pc_submit_deliverable` — the positive done signal:**
- Handler (`tools/agent-runs.ts:397–459`). Requires `PC_AGENT_RUN_ID`. POSTs to `/api/projects/:id/agent-runs/:runId/deliverable`. The server-side receipt of this call is the one "good done" signal — it triggers `run.complete()` / `gateTerminalForDeliverable` in `agent-run-settle.ts`, which is the sole terminal authority. Nothing else closes a run successfully.

**`.mcp.json` config generation:**
- `mcp-config-rewrite.ts:applyNodeLauncher` rewrites PC-owned MCP server entries in a project's `.mcp.json` to use the correct Node launcher (plain `node` in dev, `ELECTRON_RUN_AS_NODE`-flagged node when packaged). Matched by script-path suffix: `packages/mcp/dist/server.mjs` and `channel-server/server.js`. Foreign servers (user- or pod-added) are never touched.
- `pod-mcp-config.ts:parsePodMcpServerConfig` validates the shape of a per-pod MCP server config (stdio `{command, args?, env?}` or HTTP `{url}`). Rejects contradictory entries (both command + url, neither, or stdio-only fields with a url).

**MCP status endpoint:**
- `GET /api/mcp-status?projectId=<id>` (`mcp-bridge/routes.ts:51–73`) reads the project-scoped heartbeat file. Returns `{ alive: bool, toolCount, tools }`. `alive` is true only when the file's `aliveAt` timestamp is within 8 seconds of now.

## Integrations (how it connects)

- **Depends on:** Brain's HTTP API at `127.0.0.1:PC_SERVER_PORT` (every tool call is an HTTP request back into the server). `@pc/domain` for `PC_RIG_TOOL_REGISTRY`. `@pc/contracts` for DTO guards in the typed client. `@pc/runtime` for `NodeLauncher` type in config rewrite.
- **Used by:** Every `claude.exe` process (orchestrator, dispatched agent workers, workflow agents, modal sessions) — Claude Code spawns the MCP child automatically from the project's `.mcp.json`.
- **Contracts / events crossed:**
  - `POST /api/internal/mcp-handshake` — the handshake signal back to the Brain.
  - `POST /api/projects/:id/agent-runs/:runId/deliverable` — the positive done signal.
  - `POST /api/projects/:id/agent-pending-asks` — pause-and-ask from `pc_ask_*` / `pc_request_approval`.
  - `POST /api/projects/:id/agents/:name/invoke` — dispatch from `pc_invoke_agent`.
  - All other CRUD routes for work items, workflows, pods, project config.
  - The MCP child writes `data/projects/<projectId>/mcp-status.json` as a file-based heartbeat (not via the DB).

## Target shape (per north star)

The north-star design (`unified-process-supervision-2026-06-02.md §2`) explicitly says: "The per-session MCP child stays (it is the agent's hands; its tools call back into the Brain). It changes nothing about ownership." So:

- **Keep per-session.** One MCP child per `claude.exe`, owned by whoever owns that `claude.exe` (today split between Engine and Brain/ProjectRuntime; after Steps 4–5 the Engine owns all of them, but the MCP model doesn't change).
- **`pc_submit_deliverable` is already the north-star done signal.** The Step 1 stall fix is complete — it routes through `applyAgentRunTerminalEffects` as the one terminal authority.
- **The tool catalog is already unified** (Slice 016, V3 in the ledger). `PC_RIG_TOOL_REGISTRY` is the sole source; `TOOLS`/`PC_RIG_TOOL_NAMES`/`TOOL_CATALOG` all derive from it with a parity test. No consolidation work here.
- **No structural changes to this subsystem are on the migration roadmap.** What changes externally: once Steps 4–6 land, modals (`PtySession`) migrate to the Engine, so the handshake routing in `mcp-bridge/routes.ts` may need to account for all three session types via the host rather than `resolveProject`, but the MCP child itself is unchanged.

## Known issues / scar tissue

**MCP-ready lag vs banner-ready (scar tissue — Section 22):**
- `state: 'ready'` fires from the banner regex within ~1s of spawn. CC's MCP children take a further 1–3s to complete the JSON-RPC handshake and register tools. Sending a programmatic first message at `state: 'ready'` means turn 1 sees only built-in Claude tools; tools rebind by turn 2.
- Fix already shipped (Section 22): dispatched-agent spawns wait for the `mcp-handshake` POST before sending the warmup turn. Orchestrator + modal spawns do not use programmatic warmup and are unaffected.
- Reference: `server.ts:121–155` (the `oninitialized` POST), `mcp-bridge/routes.ts:81–110` (the routing), and the MEMORY note `reference_pty_ready_is_banner_not_mcp.md`.

**`pc_node_failed` is a no-op stub:**
- `tools/workflows.ts:14–37` — this handler returns a text acknowledgement but does NOT post anything to the server. It is described as "the v2 subagent spawner detects this call from the JSONL transcript" (registry description), meaning the actual failure-signal path reads the JSONL rather than receiving an HTTP call. The stub is consistent with that model but means a rebuild that switches to HTTP-receipt would need the handler wired up.

**Retry blindspot:**
- `withConnRetry` retries ECONNREFUSED/503 but not 5xx errors from the server itself (only transient connection errors and 503). A server-side 500 on a tool call returns immediately as an error to the agent without retry.

**`dispatchPcRigTool` ordered chain is O(N) per call:**
- `handlers.ts:30–46` runs all five handler functions in order until one returns non-null. For the last family in the chain (agent-run) every call traverses all five. Low overhead in practice but not ideal. A deferred cleanup (noted in `handlers.ts:8–9`) would collapse to a pure name-keyed map.

**Per-pod MCP servers are validated at write time but not at spawn:**
- `pod-mcp-config.ts` validates shape when a pod's MCP server config is saved. Capability discovery (does the server actually expose the declared tools?) is explicitly out of scope (`pod-mcp-config.ts:7`). A pod can store a well-shaped but non-functional MCP server config without detection until spawn time.

## Open questions

- After Steps 4–5 move modals to the Engine, should `mcp-bridge/routes.ts` route all handshake signals through the host (`getHostClient`) by default, with the `resolveProject` path as a legacy fallback only? Or does the orchestrator (which will remain `persistent, interactive` on the Engine) still need its own notification path?
- `pc_node_failed` is a JSONL-scrape contract, not a positive receipt. Should it be upgraded to an HTTP receipt (POST to the server) to align with the "positive receipt over inference" principle, or is the JSONL-scrape path for node failure acceptable as a typed failure signal?
- The heartbeat file (`mcp-status.json`) is written per-project but the liveness check window is a fixed 8s. Should this be tunable, or is 8s (= 4 missed heartbeats at 2s interval) the right threshold for the UI's "MCP alive" indicator?
