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
// Import from the barrel-free subpath: the registry is pure data, so this keeps
// `@pc/domain`'s `yaml` dep (and the rest of the barrel) out of the esbuild
// bundle — a barrel import breaks the dist/server.mjs boot (yaml uses a dynamic
// CJS require esbuild's ESM output can't satisfy).
import { PC_RIG_TOOL_REGISTRY } from '@pc/domain/tool-registry';
import { createToolContext } from './tools/index.ts';
import { PC_RIG_HANDLERS, dispatchPcRigTool } from './tools/handlers.ts';

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

/** Slice 016 — the MCP server tool objects, ZIPPED from the canonical
 *  `PC_RIG_TOOL_REGISTRY` (@pc/domain: name + agent description + inputSchema)
 *  IN REGISTRY ORDER. The registry is now the SOLE ordered source of truth;
 *  ListTools ordering is GUARANTEED by it instead of a hand-curated array.
 *  Execution lives in the `PC_RIG_HANDLERS` map (zipped with this list by name
 *  at CallTool time); the slice-016 parity test asserts the two are a bijection
 *  in registry order, so a half-added tool fails the build. */
export const TOOLS = PC_RIG_TOOL_REGISTRY.map((def) => ({
  name: def.name,
  description: def.description,
  inputSchema: def.inputSchema,
}));

/** Section 36 — fully-qualified slugs consumed by apps/server's
 *  `mcp__pc-rig__*` wildcard expansion. Derived from the registry order so the
 *  views can never drift. The `mcp__pc-rig__` prefix is the MCP server name
 *  Caisson scaffolds into every project's .mcp.json — keep it in sync if the
 *  server gets renamed. */
export const PC_RIG_TOOL_NAMES: readonly string[] = PC_RIG_TOOL_REGISTRY.map(
  (d) => `mcp__pc-rig__${d.name}` as const,
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
  // Slice 016 — dispatch through the name-keyed handler map. Each entry wraps
  // the existing ordered handler chain (handlers.ts), so behavior is
  // byte-identical to the pre-slice chain; an unknown name throws the same
  // error string.
  const handler = PC_RIG_HANDLERS[req.params.name];
  if (handler) return handler(args, toolContext);
  return dispatchPcRigTool(req.params.name, args, toolContext);
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
