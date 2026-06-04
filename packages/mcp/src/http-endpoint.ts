// FD-2 adoption — ONE shared HTTP MCP tools endpoint, every PC-spawned
// claude.exe a client. Replaces the per-session stdio pc-rig child.
//
// Transport: Streamable HTTP (what a `{"type":"http"}` mcp.json entry speaks).
// Identity: per-session X-PC-* headers baked into the session-local mcp.json
// at spawn time + X-PC-Token (HMAC, verified by the injected `verify` — the
// server only trusts claims it signed itself). Claims are re-verified on EVERY
// request, and a tool call's context is built from THAT request's headers, so
// no state survives a claim mismatch.
//
// Quirk honored from the FD-2 spike (labs/fd2-shared-http-mcp): claude.exe
// opens TWO MCP sessions after a server restart (one re-lists tools, one
// carries the call) — sessions live in a map, never assume one per process.
// Unknown session id → the JSON-RPC -32001 shape that makes CC re-initialize
// hands-off (~5s, proven).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { TOOLS } from './server.ts';
import { createToolContext } from './tools/index.ts';
import { PC_RIG_HANDLERS, dispatchPcRigTool } from './tools/handlers.ts';

/** The identity a PC-spawned session claims on every MCP request. Mirrors the
 *  env-var set the stdio pc-rig child read at boot. */
export interface PcMcpClaims {
  projectId: string;
  /** PC session id (orchestrator session ULID, modal `ad-*`/`wb-*`/`sw-*`). */
  sessionId: string;
  /** CC session uuid — handshake routing + dispatched-agent identity. */
  agentSessionId: string;
  agentRunId: string;
  dispatcherSessionId: string;
  parentWorkItemId: string;
  invokeDepth: number;
}

export const PC_MCP_CLAIM_HEADERS = {
  projectId: 'x-pc-project-id',
  sessionId: 'x-pc-session-id',
  agentSessionId: 'x-pc-agent-session-id',
  agentRunId: 'x-pc-agent-run-id',
  dispatcherSessionId: 'x-pc-dispatcher-session-id',
  parentWorkItemId: 'x-pc-parent-work-item-id',
  invokeDepth: 'x-pc-invoke-depth',
} as const;

export const PC_MCP_TOKEN_HEADER = 'x-pc-token';

function headerValue(headers: IncomingMessage['headers'], name: string): string {
  const v = headers[name];
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export function parseClaimsFromHeaders(headers: IncomingMessage['headers']): PcMcpClaims {
  return {
    projectId: headerValue(headers, PC_MCP_CLAIM_HEADERS.projectId),
    sessionId: headerValue(headers, PC_MCP_CLAIM_HEADERS.sessionId),
    agentSessionId: headerValue(headers, PC_MCP_CLAIM_HEADERS.agentSessionId),
    agentRunId: headerValue(headers, PC_MCP_CLAIM_HEADERS.agentRunId),
    dispatcherSessionId: headerValue(headers, PC_MCP_CLAIM_HEADERS.dispatcherSessionId),
    parentWorkItemId: headerValue(headers, PC_MCP_CLAIM_HEADERS.parentWorkItemId),
    invokeDepth: Number(headerValue(headers, PC_MCP_CLAIM_HEADERS.invokeDepth) || '0'),
  };
}

export interface PcRigHttpEndpointDeps {
  /** apps/server port — tool handlers call the API over localhost. */
  serverPort: number;
  /** Token check — recompute the HMAC over the claims (mcp-http-auth). */
  verify(claims: PcMcpClaims, token: string): boolean;
  /** Fired once per MCP session when CC's JSON-RPC handshake completes — the
   *  ReadyGate signal that used to be the stdio child's POST. */
  onInitialized?(claims: PcMcpClaims): void;
  log?(line: string): void;
}

export interface PcRigHttpEndpoint {
  /** Bridge a raw node request into the transport. Owns the response. */
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Open MCP session count (diagnostics). */
  sessionCount(): number;
  close(): void;
}

interface SessionEntry {
  transport: InstanceType<typeof StreamableHTTPServerTransport>;
  claims: PcMcpClaims;
}

export function createPcRigHttpEndpoint(deps: PcRigHttpEndpointDeps): PcRigHttpEndpoint {
  const sessions = new Map<string, SessionEntry>();
  const log = deps.log ?? (() => {});

  function contextFor(claims: PcMcpClaims) {
    return createToolContext({
      projectId: claims.projectId,
      agentSessionId: claims.agentSessionId,
      sessionId: claims.sessionId,
      dispatcherSessionId: claims.sessionId || claims.dispatcherSessionId,
      agentRunId: claims.agentRunId,
      agentParentWorkItemId: claims.parentWorkItemId,
      agentInvokeDepth: claims.invokeDepth,
      serverPort: deps.serverPort,
    });
  }

  function buildServer(sessionIdRef: { id: string }): Server {
    const server = new Server({ name: 'pc-rig', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS as unknown as typeof TOOLS,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      // Context from the SESSION's verified claims (headers are static per
      // session — they come from the spawn-time mcp.json; per-request claim
      // drift is rejected before the transport sees the request).
      const entry = sessions.get(sessionIdRef.id);
      if (!entry) throw new Error(`pc-rig http: unknown mcp session ${sessionIdRef.id}`);
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const ctx = contextFor(entry.claims);
      const handler = PC_RIG_HANDLERS[req.params.name];
      if (handler) return handler(args, ctx);
      return dispatchPcRigTool(req.params.name, args, ctx);
    });
    return server;
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8');
    try {
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  function reject(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: status === 401 ? -32000 : -32001, message },
        id: null,
      }),
    );
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const claims = parseClaimsFromHeaders(req.headers);
    const token = headerValue(req.headers, PC_MCP_TOKEN_HEADER);
    if (!deps.verify(claims, token)) {
      log(`pc-rig http: REJECTED token (project=${claims.projectId || '?'})`);
      reject(res, 401, 'invalid PC identity token');
      return;
    }

    const sid = headerValue(req.headers, 'mcp-session-id');
    try {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const existing = sid ? sessions.get(sid) : undefined;
        if (existing) {
          await existing.transport.handleRequest(req, res, body);
          return;
        }
        if (!sid && isInitializeRequest(body)) {
          const sessionIdRef = { id: '(initializing)' };
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSid: string) => {
              sessionIdRef.id = newSid;
              sessions.set(newSid, { transport, claims });
              log(
                `pc-rig http: session ${newSid} opened (project=${claims.projectId} cc=${claims.agentSessionId || '-'})`,
              );
            },
          });
          transport.onclose = () => {
            if (sessions.delete(sessionIdRef.id)) {
              log(`pc-rig http: session ${sessionIdRef.id} closed`);
            }
          };
          const server = buildServer(sessionIdRef);
          // The ReadyGate handshake signal — same semantics as the stdio
          // child's oninitialized POST, minus the HTTP hop.
          server.oninitialized = () => {
            if (claims.projectId && claims.agentSessionId) deps.onInitialized?.(claims);
          };
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }
        // Unknown session (server restarted) → -32001 tells CC to re-init.
        reject(res, 404, 'Session not found');
        return;
      }
      if ((req.method === 'GET' || req.method === 'DELETE') && sid && sessions.has(sid)) {
        await sessions.get(sid)!.transport.handleRequest(req, res);
        return;
      }
      reject(res, 404, 'Session not found');
    } catch (e) {
      log(`pc-rig http: ERROR ${(e as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String((e as Error).message ?? e) }));
      }
    }
  }

  return {
    handleRequest,
    sessionCount: () => sessions.size,
    close() {
      for (const { transport } of sessions.values()) {
        try {
          void transport.close();
        } catch {
          /* best-effort */
        }
      }
      sessions.clear();
    },
  };
}
