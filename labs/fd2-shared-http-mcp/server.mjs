// FD-2 spike — ONE shared HTTP MCP tools server, many claude.exe clients.
//
// Serves three probe tools over Streamable HTTP (the transport claude.exe's
// `{"type":"http"}` mcp.json entry speaks). Every tool result echoes the
// caller's identity as the SERVER saw it for THAT request:
//   - `probe` ........ the X-PC-Probe header from the per-session .mcp.json
//   - `mcpSessionId` . the MCP-level session the transport assigned
//   - `serverBootId` . random per server process — proves restart recovery
// Run:  node server.mjs   (port 4555; Ctrl+C to kill for the restart test)
//
// Identity is read PER REQUEST from headers (extra.requestInfo in SDK ≥1.12,
// with a transport-keyed fallback captured before handleRequest). This is the
// make-or-break FD-2 item: a shared server must know who's calling.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Resolve the SDK through @pc/mcp's node_modules (pnpm gives deps per-package).
const requireFromMcp = createRequire(
  new URL('../../packages/mcp/package.json', import.meta.url),
);
const { Server } = requireFromMcp('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = requireFromMcp(
  '@modelcontextprotocol/sdk/server/streamableHttp.js',
);
const { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } =
  requireFromMcp('@modelcontextprotocol/sdk/types.js');

const PORT = 4555;
const BOOT_ID = randomUUID().slice(0, 8);
const LOG = new URL('./spike-server.log', import.meta.url);

function log(line) {
  const stamped = `${new Date().toISOString()} [boot ${BOOT_ID}] ${line}`;
  console.log(stamped);
  appendFileSync(LOG, stamped + '\n');
}

const TOOLS = [
  {
    name: 'spike_whoami',
    description:
      'FD-2 identity probe. Returns the identity the shared server saw for THIS call. Call it and paste the raw JSON back.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'spike_slow',
    description:
      'FD-2 concurrency probe. Sleeps ~2000ms server-side, then returns identity + start/end timestamps.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'spike_echo',
    description: 'FD-2 round-trip probe. Echoes the given text back with identity attached.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'text to echo' } },
      required: ['text'],
    },
  },
];

/** mcpSessionId → transport, and mcpSessionId → headers of the most recent
 *  request (fallback identity channel if extra.requestInfo is absent). */
const transports = new Map();
const lastHeaders = new Map();

function identityFrom(extra, sessionId) {
  const viaExtra = extra?.requestInfo?.headers ?? null;
  const viaFallback = lastHeaders.get(sessionId) ?? null;
  const headers = viaExtra ?? viaFallback ?? {};
  const probe = headers['x-pc-probe'] ?? '(missing)';
  return {
    probe,
    identitySource: viaExtra ? 'extra.requestInfo' : viaFallback ? 'fallback-map' : 'none',
    mcpSessionId: sessionId ?? '(none)',
    serverBootId: BOOT_ID,
  };
}

function buildMcpServer(sessionIdRef) {
  const server = new Server(
    { name: 'fd2-spike', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => {
    log(`tools/list  session=${sessionIdRef.id}`);
    return { tools: TOOLS };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const t0 = Date.now();
    const id = identityFrom(extra, sessionIdRef.id);
    log(`tools/call ${req.params.name}  probe=${id.probe}  session=${sessionIdRef.id}`);
    if (req.params.name === 'spike_slow') {
      await new Promise((r) => setTimeout(r, 2000));
    }
    const payload = {
      tool: req.params.name,
      ...id,
      ...(req.params.name === 'spike_echo' ? { echo: req.params.arguments?.text ?? '' } : {}),
      startedAt: new Date(t0).toISOString(),
      finishedAt: new Date().toISOString(),
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  });
  return server;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8');
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

const http = createServer(async (req, res) => {
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end('not the mcp endpoint');
    return;
  }
  const sid = req.headers['mcp-session-id'];
  try {
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (sid && transports.has(sid)) {
        lastHeaders.set(sid, { ...req.headers });
        await transports.get(sid).handleRequest(req, res, body);
        return;
      }
      if (!sid && isInitializeRequest(body)) {
        const sessionIdRef = { id: '(initializing)' };
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSid) => {
            sessionIdRef.id = newSid;
            transports.set(newSid, transport);
            lastHeaders.set(newSid, { ...req.headers });
            log(`session initialized ${newSid}  probe=${req.headers['x-pc-probe'] ?? '?'}`);
          },
        });
        transport.onclose = () => {
          if (sessionIdRef.id) {
            transports.delete(sessionIdRef.id);
            lastHeaders.delete(sessionIdRef.id);
            log(`session closed ${sessionIdRef.id}`);
          }
        };
        await buildMcpServer(sessionIdRef).connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      // Unknown session (e.g. server restarted and lost state) → the MCP
      // "session not found" shape that tells claude.exe to re-initialize.
      log(`UNKNOWN session ${sid ?? '(none)'} → 404 re-init signal`);
      res.writeHead(404, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        }),
      );
      return;
    }
    if ((req.method === 'GET' || req.method === 'DELETE') && sid && transports.has(sid)) {
      await transports.get(sid).handleRequest(req, res);
      return;
    }
    res.writeHead(405).end();
  } catch (e) {
    log(`ERROR ${e.message}`);
    if (!res.headersSent) res.writeHead(500).end(String(e?.message ?? e));
  }
});

http.listen(PORT, '127.0.0.1', () => {
  log(`FD-2 spike server listening on http://127.0.0.1:${PORT}/mcp`);
});
