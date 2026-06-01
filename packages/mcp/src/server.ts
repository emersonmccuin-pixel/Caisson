// Per-project MCP server. Spawned by each project's claude.exe via its
// .mcp.json. Tools are scoped to PC_PROJECT_ID — set by the per-project config
// at substitution time. Work-item and workflow calls shim through
// to apps/server's project-scoped HTTP API so dispatch logic stays in one place.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AGENT_MANAGEMENT_TOOLS,
  ANSWER_PENDING_TOOL,
  APPROVE_WORK_ITEM_TOOL,
  ASK_ORCHESTRATOR_TOOL,
  ASK_USER_TOOL,
  ATTACH_TO_WORK_ITEM_TOOL,
  COMPLETE_NODE_TOOL,
  CONTINUE_AGENT_TOOL,
  CREATE_AGENT_WORK_ITEM_TOOL,
  CREATE_WORKFLOW_TOOL,
  CREATE_WORK_ITEM_TOOL,
  DELETE_WORKFLOW_TOOL,
  FIRE_WORKFLOW_TOOL,
  GET_STAGES_TOOL,
  GET_WORKFLOW_TOOL,
  GET_WORK_ITEM_TOOL,
  INSPECT_AGENT_RUN_TOOL,
  INVOKE_AGENT_TOOL,
  KILL_AGENT_RUN_TOOL,
  LIST_AGENTS_TOOL,
  LIST_AREAS_TOOL,
  LIST_FIELD_SCHEMAS_TOOL,
  LIST_MY_RUNS_TOOL,
  LIST_STAGES_TOOL,
  LIST_WORKFLOWS_TOOL,
  LIST_WORK_ITEMS_TOOL,
  LOG_BUG_TOOL,
  MOVE_WORK_ITEM_TOOL,
  NODE_FAILED_TOOL,
  PUBLISH_WORKFLOW_TOOL,
  READ_WORKFLOW_DRAFT_TOOL,
  REJECT_WORK_ITEM_TOOL,
  REPLACE_FIELD_SCHEMAS_TOOL,
  REPLACE_STAGES_TOOL,
  REQUEST_APPROVAL_TOOL,
  SAVE_WORKFLOW_DRAFT_TOOL,
  UPDATE_WORKFLOW_TOOL,
  UPDATE_WORK_ITEM_TOOL,
  WRITE_CLAUDE_MD_TOOL,
  createToolContext,
  handleAgentRunTool,
  handleAgentTool,
  handleProjectConfigTool,
  handleWorkItemTool,
  handleWorkflowTool,
} from './tools/index.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// packages/mcp/src/server.ts → trunk root is three levels up. Used as the
// fallback data dir; PC_DATA_DIR override wins.
const ROOT = resolve(__dirname, '..', '..', '..');
const DATA = process.env.PC_DATA_DIR ? resolve(process.env.PC_DATA_DIR) : resolve(ROOT, 'data');
const PROJECT_ID = process.env.PC_PROJECT_ID ?? '';
const SERVER_PORT = Number(process.env.PC_SERVER_PORT ?? 4040);
// Section 22 — set by agent-run-manager for dispatched-agent spawns. Absent
// for orchestrator + agent-designer paths (those set PC_SESSION_ID instead;
// they don't suffer the spawn-time race so we skip the handshake POST).
const AGENT_SESSION_ID = process.env.PC_AGENT_SESSION_ID ?? '';

// Per-project log + heartbeat — keep each project's MCP signals isolated.
const PROJECT_DATA = PROJECT_ID ? resolve(DATA, 'projects', PROJECT_ID) : DATA;
const STATUS = resolve(PROJECT_DATA, 'mcp-status.json');

/** Section 36 — derived export consumed by apps/server's
 *  `pod-tool-catalog.ts` for `mcp__pc-rig__*` wildcard expansion. Replaces
 *  the hand-maintained flat array that previously had to be kept in sync
 *  with TOOLS (the catalog-drift trap). `TOOLS` below is the sole source. */
export const TOOLS = [
  CREATE_WORK_ITEM_TOOL,
  CREATE_AGENT_WORK_ITEM_TOOL,
  APPROVE_WORK_ITEM_TOOL,
  REJECT_WORK_ITEM_TOOL,
  LOG_BUG_TOOL,
  MOVE_WORK_ITEM_TOOL,
  UPDATE_WORK_ITEM_TOOL,
  // Workflow definitions and handlers live in tools/workflows.ts; keep these
  // constants in-place so ListTools preserves the pre-split ordering.
  ...AGENT_MANAGEMENT_TOOLS,
  GET_WORK_ITEM_TOOL,
  LIST_WORK_ITEMS_TOOL,
  LIST_AREAS_TOOL,
  SAVE_WORKFLOW_DRAFT_TOOL,
  READ_WORKFLOW_DRAFT_TOOL,
  GET_STAGES_TOOL,
  PUBLISH_WORKFLOW_TOOL,
  WRITE_CLAUDE_MD_TOOL,
  LIST_STAGES_TOOL,
  LIST_AGENTS_TOOL,
  LIST_WORKFLOWS_TOOL,
  FIRE_WORKFLOW_TOOL,
  COMPLETE_NODE_TOOL,
  NODE_FAILED_TOOL,
  LIST_FIELD_SCHEMAS_TOOL,
  CREATE_WORKFLOW_TOOL,
  UPDATE_WORKFLOW_TOOL,
  DELETE_WORKFLOW_TOOL,
  GET_WORKFLOW_TOOL,
  REPLACE_STAGES_TOOL,
  REPLACE_FIELD_SCHEMAS_TOOL,
  ATTACH_TO_WORK_ITEM_TOOL,
  INVOKE_AGENT_TOOL,
  CONTINUE_AGENT_TOOL,
  LIST_MY_RUNS_TOOL,
  INSPECT_AGENT_RUN_TOOL,
  KILL_AGENT_RUN_TOOL,
  ASK_ORCHESTRATOR_TOOL,
  ASK_USER_TOOL,
  REQUEST_APPROVAL_TOOL,
  ANSWER_PENDING_TOOL,
] as const;

/** Section 36 — fully-qualified slugs consumed by apps/server's
 *  `mcp__pc-rig__*` wildcard expansion. Derived from TOOLS so the two can
 *  never drift; the previous hand-maintained flat array (and its drift test)
 *  are deleted. The `mcp__pc-rig__` prefix is the MCP server name Caisson scaffolds
 *  into every project's .mcp.json — keep it in sync if the server gets
 *  renamed. */
export const PC_RIG_TOOL_NAMES: readonly string[] = TOOLS.map(
  (t) => `mcp__pc-rig__${t.name}` as const,
);

const toolContext = createToolContext({
  projectId: PROJECT_ID,
  agentSessionId: AGENT_SESSION_ID,
  sessionId: process.env.PC_SESSION_ID ?? '',
  dispatcherSessionId: process.env.PC_SESSION_ID || process.env.PC_DISPATCHER_SESSION_ID || '',
  agentRunId: process.env.PC_AGENT_RUN_ID ?? '',
  agentParentWorkItemId: process.env.PC_AGENT_PARENT_WORK_ITEM_ID ?? '',
  agentInvokeDepth: Number(process.env.PC_AGENT_INVOKE_DEPTH ?? '0'),
  serverPort: SERVER_PORT,
});

function writeStatus() {
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(
      STATUS,
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          aliveAt: new Date().toISOString(),
          tools: TOOLS.map((t) => t.name),
          toolCount: TOOLS.length,
        },
        null,
        2,
      ),
    );
  } catch {
    /* status file is best-effort */
  }
}

function heartbeat() {
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(
      STATUS,
      JSON.stringify(
        {
          pid: process.pid,
          aliveAt: new Date().toISOString(),
          tools: TOOLS.map((t) => t.name),
          toolCount: TOOLS.length,
        },
        null,
        2,
      ),
    );
  } catch {
    /* best-effort */
  }
}

const server = new Server(
  { name: 'pc-rig', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

// Section 22 — fire when CC's MCP client finishes the JSON-RPC handshake
// (the `initialized` notification, last step before tools are safely
// callable). Lets agent-run-manager gate its programmatic spawn-time
// warmup-send on the real handshake-complete signal rather than the
// banner-render `state: 'ready'` (which fires before MCP is connected
// and used to drop the warmup's Enter under concurrent spawn). Dispatched-
// agent path only — orchestrator + agent-designer don't suffer the race.
// Fire-once guard at the AbortController level: pc-rig is a fresh process
// per spawn, so oninitialized should only ever fire once anyway, but
// defense-in-depth.
let handshakeNotified = false;
server.oninitialized = () => {
  if (handshakeNotified) return;
  if (!PROJECT_ID || !AGENT_SESSION_ID) return;
  handshakeNotified = true;
  const payload = JSON.stringify({
    projectId: PROJECT_ID,
    agentSessionId: AGENT_SESSION_ID,
  });
  const req = httpRequest({
    host: '127.0.0.1',
    port: SERVER_PORT,
    method: 'POST',
    path: '/api/internal/mcp-handshake',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  });
  // Fire-and-forget. Failure is non-fatal — agent-run-manager's timeout
  // fallback catches us if this POST never lands.
  req.on('error', () => { /* best-effort */ });
  req.write(payload);
  req.end();
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS as unknown as typeof TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const workItemResult = await handleWorkItemTool(req.params.name, args, toolContext);
  if (workItemResult) return workItemResult;
  const agentResult = await handleAgentTool(req.params.name, args, toolContext);
  if (agentResult) return agentResult;
  const workflowResult = await handleWorkflowTool(req.params.name, args, toolContext);
  if (workflowResult) return workflowResult;
  const projectConfigResult = await handleProjectConfigTool(req.params.name, args, toolContext);
  if (projectConfigResult) return projectConfigResult;
  const agentRunResult = await handleAgentRunTool(req.params.name, args, toolContext);
  if (agentRunResult) return agentRunResult;

  throw new Error(`unknown tool: ${req.params.name}`);
});

// Section 36 — guard the stdio-attach + heartbeat behind an "am I the entry
// point?" check so consumers that only need the TOOLS array (apps/server's
// pod-tool-catalog re-exports PC_RIG_TOOL_NAMES) can import this module
// without booting an MCP server and pinning the event loop. The mcp build
// (`scripts/build.mjs`) produces dist/server.mjs which IS the entry point —
// import.meta.url matches process.argv[1]'s file URL there. When Caisson's server
// imports `@pc/mcp` from a test or runtime context, the comparison fails and
// the side effects stay parked.
const ENTRY_URL = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === ENTRY_URL) {
  writeStatus();
  const heartbeatTimer = setInterval(heartbeat, 2000);
  heartbeatTimer.unref?.();

  await server.connect(new StdioServerTransport());
}
