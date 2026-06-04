# MCP (tools bridge)

> **Role:** cross-cutting (adapter layer — sits between the Engine/Brain and every claude.exe)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:** `packages/mcp/src/server.ts` · `packages/mcp/src/tools/` · `packages/domain/src/tool-registry.ts` · `apps/server/src/services/mcp-config-rewrite.ts` · `apps/server/src/services/pod-mcp-config.ts` · `apps/server/src/features/mcp-bridge/routes.ts`

---

## What it is (plain English)

Every agent gets a private **messenger process** that Caisson starts alongside it. When the agent wants to do something — create a work item, dispatch a sub-agent, submit its finished work — it calls a tool; the messenger receives that call and forwards it as a plain HTTP request to the one Caisson server. The server does the real work and sends back a result. The messenger owns nothing; it holds no state; it dies when the agent dies. It is purely a relay.

---

## What it's supposed to do (intent)

Give each agent exactly one typed interface to every app service — work items, agent runs, workflows, pods, project config — without the agent needing to know about HTTP routes, database schemas, or server internals. MCP is an adapter over shared contracts, not a separate product API. It is disposable per-session; the Brain and the database own the truth.

---

## The parts (every component, plain English)

### 1. The messenger itself

**Since FD-2 adoption (P6 Slice 0, 2026-06-04) the messenger is NOT a separate process** — it's ONE
shared HTTP endpoint inside the API server (`/api/mcp`, impl `@pc/mcp/http-endpoint`). Each spawned
session's `mcp.json` carries a `{type:'http'}` entry with signed identity headers (X-PC-* + HMAC);
Claude Code speaks MCP JSON-RPC over that. `packages/mcp/src/server.ts` survives as the canonical
TOOL DATA source only (the `TOOLS` array + `PC_RIG_TOOL_NAMES`, zipped from the registry) — ☠ the
stdio child, config-rewrite, staging, and the heartbeat `mcp-status.json` file.

### 2. The handshake signal

When Claude Code finishes its MCP setup with the messenger (the JSON-RPC `initialized` notification), the messenger POSTs `POST /api/internal/mcp-handshake` back to the server (`server.ts:132–155`). This only applies to **dispatched agent** spawns (where `PC_AGENT_SESSION_ID` is in the environment).

The Brain routes that signal to the right owner: the active-run registry (for in-process dispatched agents), the agent host via a `notify-mcp-handshake` command, or the project orchestrator (`mcp-bridge/routes.ts:81–110`). This is how the run manager can wait for tools to actually be live before sending the agent its first message — rather than just waiting for the welcome banner, which arrives 1–3 seconds earlier. (See also "MCP-ready lag" in Known issues.)

Orchestrator and modal spawns don't send this signal — they don't use programmatic first-turn sends and aren't affected by the race.

### 3. ~~The heartbeat~~ ☠ (P6 Slice 0)

The file-based `mcp-status.json` heartbeat died with the stdio child — the shared HTTP endpoint
lives inside the API server; if the API answers, the tools are up.

### 4. The tool families (55 tools total)

All 55 tool definitions live in one place: `packages/domain/src/tool-registry.ts:PC_RIG_TOOL_REGISTRY` (line 52). The messenger's tool list (`TOOLS`) and the server's wildcard-expansion catalog (`PC_RIG_TOOL_NAMES`) both derive from this single registry by `.map()`. A build test (Slice-016) asserts they stay in sync — a half-added tool fails the build.

**FD-16 tiers (shipped 2026-06-03):** every tool also carries a tier in `PC_RIG_TOOL_TIERS` (same file; parity guard `packages/domain/test/tool-tiers.test.ts`): `first-order` (meant for everyday pod allowlists), `on-demand` (reachable only through the door below), `worker` (dispatched-agent-side; never callable through the door).

| Family | What the tools do | Tool names |
|---|---|---|
| **work-item** | Create, read, update, move, resolve, and attach things to cards — and (M5) READ attachments | `pc_create_work_item`, `pc_create_agent_work_item`, `pc_resolve_work_item`, `pc_log_bug`, `pc_move_work_item`, `pc_update_work_item`, `pc_get_work_item`, `pc_list_work_items`, `pc_list_areas`, `pc_update_area`, `pc_attach_to_work_item`, `pc_list_attachments`, `pc_get_attachment` |
| **agent** | Create, edit, delete, and read agents/pods; manage their knowledge docs, secrets, and extra tool servers | `pc_create_agent`, `pc_get_agent`, `pc_update_agent`, `pc_delete_agent`, `pc_list_agents`, `pc_create_knowledge`, `pc_update_knowledge`, `pc_delete_knowledge`, `pc_knowledge_read`, `pc_create_agent_secret`, `pc_delete_agent_secret`, `pc_add_agent_mcp_server`, `pc_delete_agent_mcp_server`, `pc_list_agent_audit` |
| **agent-run** | Dispatch agents, continue them, pause-and-ask, inspect/kill runs, read your contract (M5), submit finished work | `pc_invoke_agent`, `pc_continue_agent`, `pc_list_my_runs`, `pc_inspect_agent_run`, `pc_kill_agent_run`, `pc_ask_orchestrator`, `pc_ask_user`, `pc_request_approval`, `pc_answer_pending`, `pc_get_contract`, `pc_submit_deliverable` |
| **workflow** | Author and control workflows (☠ draft tools, P7) | `pc_publish_workflow`, `pc_list_workflows`, `pc_fire_workflow`, `pc_complete_node`, `pc_node_failed`, `pc_create_workflow`, `pc_update_workflow`, `pc_delete_workflow`, `pc_get_workflow`, `pc_get_workflow_run` |
| **project** | Read/write project config, stages, and field schemas | `pc_write_claude_md`, `pc_list_stages`, `pc_list_field_schemas`, `pc_replace_stages`, `pc_replace_field_schemas` |

| **none (meta)** | The FD-16 on-demand door | `pc_find_tool` (keyword-search the catalog; returns matches with tier + input schema), `pc_call_tool` (execute an `on-demand` tier tool through the SAME handler chain — same routes, same audit rows; refuses `first-order`/`worker`/unknown with a typed message) |

When a tool call arrives, the messenger looks it up in a name-keyed handler map first, then falls back to an ordered chain that runs the family handlers until one returns a non-null result (`handlers.ts:30–51`); the meta door runs last and re-enters the same chain for its target. (The chain is O(N) per call — a known cleanup deferred in `handlers.ts:8–9`.)

### 5. The done-signal tool (`pc_submit_deliverable`)

This is the most important tool. When an agent finishes its job, it calls `pc_submit_deliverable`, which POSTs to `/api/projects/:id/agent-runs/:runId/deliverable`. The server-side receipt of that POST is the **one and only "good done" signal** — it triggers the single terminal authority (`agent-run-settle.ts`) that closes the run. Nothing else closes a run successfully. No guessing from logs, no inferred completion. (`tools/agent-runs.ts:397–459`)

### 6. Connection resilience

Every tool call is wrapped in `withConnRetry` (`tools/retry.ts`): 5 attempts, exponential backoff 80ms–1s, retrying on ECONNREFUSED / ECONNRESET / 503. This lets a tool call survive an ~1s API restart window. **Note:** 5xx errors from the server itself are not retried — only transient connection failures are.

Each call carries a `ToolContext` built once at process startup, capturing env vars (`PC_PROJECT_ID`, `PC_AGENT_SESSION_ID`, `PC_SESSION_ID`, `PC_AGENT_RUN_ID`, `PC_AGENT_PARENT_WORK_ITEM_ID`, `PC_AGENT_INVOKE_DEPTH`, `PC_SERVER_PORT`) and typed HTTP helpers (`postServer`, `getServer`, etc.). The context also injects a `withRichLinkHint` reminder that tells the agent to format callsigns and file paths as clickable `pc://` links. (`tools/context.ts:137–195`)

### 7. Config generation (writing `.mcp.json`)

Two small services handle config:

- **`mcp-config-rewrite.ts`** — rewrites the PC-owned entries in a project's `.mcp.json` to use the right Node launcher: plain `node` in dev, `ELECTRON_RUN_AS_NODE`-flagged node when running as the packaged app. Matched by script-path suffix (`packages/mcp/dist/server.mjs` and `channel-server/server.js`). ☠ The `channel-server` entry disappears with FD-3. Foreign servers added by users or pods are never touched.
- **`pod-mcp-config.ts`** — validates the shape of a per-pod extra MCP server config (stdio `{command, args?, env?}` or HTTP `{url}`) when it's saved to the database. Rejects contradictory entries (both command + url, or neither). Shape is checked at write time; whether the server actually works is not — that surfaces at spawn.

---

## How it connects

- **Depends on:** the Brain's HTTP API at `127.0.0.1:PC_SERVER_PORT` (every tool call is an HTTP request back into the server) · `@pc/domain` for `PC_RIG_TOOL_REGISTRY` · `@pc/contracts` for DTO guards in the typed client · `@pc/runtime` for the `NodeLauncher` type used in config rewrite.
- **Used by:** every `claude.exe` process — the orchestrator, dispatched agent workers, workflow step agents, and modal sessions. Claude Code spawns the messenger automatically from the project's `.mcp.json`.
- **Signals crossed:** `POST /api/internal/mcp-handshake` (tools-live signal) · `POST /api/projects/:id/agent-runs/:runId/deliverable` (the done signal) · `POST /api/projects/:id/agent-pending-asks` (pause-and-ask) · `POST /api/projects/:id/agents/:name/invoke` (dispatch) · all CRUD routes for work items, workflows, pods, and project config · `data/projects/<projectId>/mcp-status.json` (file-based heartbeat).

---

## Target shape (per north star + Foundation Decisions)

The north-star design (`unified-process-supervision-2026-06-02.md §2`) says explicitly: "The per-session MCP child stays (it is the agent's hands; its tools call back into the Brain). It changes nothing about ownership."

- **Keep one messenger per agent session.** After Steps 4–5 move modals to the Engine, the handshake routing in `mcp-bridge/routes.ts` may need to account for all three session types via the host rather than `resolveProject`, but the messenger itself is unchanged.
  - ⚠️ **Under challenge — FD-2 (2026-06-03):** there is a proposal to replace the per-session stdio messenger with ONE shared HTTP tools endpoint on the Brain (since every messenger is already a stateless relay to the Brain anyway). Pending a spike that proves claude.exe's HTTP MCP transport works correctly: per-call identity, registration timing, concurrency, restart resilience. If the spike succeeds, the "keep per-session" verdict gets rewritten.
- **`pc_submit_deliverable` is already the north-star done signal.** Step 1 stall fix is complete — it routes through `applyAgentRunTerminalEffects` as the one terminal authority.
- **The tool catalog is already unified** (Slice 016). `PC_RIG_TOOL_REGISTRY` is the sole source; `TOOLS`, `PC_RIG_TOOL_NAMES`, and `TOOL_CATALOG` all derive from it with a parity test. No consolidation work remains here.
- ☠ **FD-3:** the `channel-server` entry in `.mcp.json` config is sentenced — it disappears once FD-3 lands.

---

## Known issues / scar tissue

**MCP-ready lag (scar tissue — Section 22):**
Claude Code fires the `state: 'ready'` signal from the welcome banner within ~1s of spawn. The messenger takes a further 1–3s to complete the JSON-RPC handshake and register tools. Sending a first message at banner-ready means the agent's turn 1 sees only Claude's built-in tools; the app's tools rebind by turn 2. Fix shipped (Section 22): dispatched-agent spawns now wait for the `mcp-handshake` POST before sending the warmup turn. Orchestrator and modal spawns are unaffected. See `server.ts:121–155`, `mcp-bridge/routes.ts:81–110`, and memory note `reference_pty_ready_is_banner_not_mcp.md`.

**`pc_node_failed` is a no-op stub:**
`tools/workflows.ts:14–37` — this handler returns a text acknowledgement but does NOT POST anything to the server. The registry description says "the v2 subagent spawner detects this call from the JSONL transcript," meaning the actual failure-signal path reads the JSONL rather than receiving an HTTP call. The stub is consistent with that model, but a rebuild that switches to HTTP-receipt would need the handler wired up. This sits in tension with the "positive receipt over inference" principle.

**Retry blindspot:**
`withConnRetry` retries connection failures (ECONNREFUSED/ECONNRESET/503) but not server-side 5xx errors. A server-side 500 on a tool call returns immediately as an error to the agent without any retry.

**Per-pod MCP servers validated at write, not at spawn:**
`pod-mcp-config.ts` checks the *shape* of a per-pod MCP server config when saved. Whether the server actually exposes the declared tools is explicitly out of scope (`pod-mcp-config.ts:7`). A well-shaped but non-functional config goes undetected until the agent tries to launch.

---

## Decisions & open questions

**For Emerson (product calls):**
1. **One shared tools endpoint vs. one messenger per agent.** Today every agent gets its own messenger. The proposal under FD-2 is one shared HTTP endpoint instead. If the spike succeeds: slightly simpler infrastructure, one less process per agent. If it fails: no change. No product-visible difference either way — but worth knowing a decision is pending.

**Technical:**
- After Steps 4–5 move modals to the Engine, should `mcp-bridge/routes.ts` route all handshake signals through the host (`getHostClient`) by default, with the `resolveProject` path as a legacy fallback? Or does the orchestrator (which remains persistent/interactive on the Engine) still need its own notification path?
- `pc_node_failed` is a JSONL-scrape contract, not a positive receipt. Should it be upgraded to an HTTP POST to align with "positive receipt over inference," or is JSONL-scrape acceptable as a typed failure signal for node failures?
- The heartbeat liveness window is fixed at 8s (four missed beats at 2s). Should it be tunable, or is 8s the right threshold for the UI's "MCP alive" indicator?
