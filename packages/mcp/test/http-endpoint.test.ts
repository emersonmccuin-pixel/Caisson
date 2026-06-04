// FD-2 — shared HTTP MCP endpoint smoke. Replaces the stdio bundle-smoke test
// (☠ the per-session stdio child). Boots a REAL http server around
// createPcRigHttpEndpoint, drives the Streamable-HTTP initialize + tools/list
// handshake, and asserts ListTools returns the TOOLS names IN REGISTRY ORDER.
// Also proves the identity door: bad token → 401, no MCP traffic; the
// `oninitialized` handshake callback fires with the session's claims.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';

import {
  createPcRigHttpEndpoint,
  PC_MCP_CLAIM_HEADERS,
  PC_MCP_TOKEN_HEADER,
  type PcMcpClaims,
} from '../src/http-endpoint.ts';
import { TOOLS } from '../src/server.ts';

interface Harness {
  port: number;
  initialized: PcMcpClaims[];
  close(): Promise<void>;
}

function startHarness(): Promise<Harness> {
  const initialized: PcMcpClaims[] = [];
  const endpoint = createPcRigHttpEndpoint({
    serverPort: 0,
    verify: (_claims, token) => token === 'good-token',
    onInitialized: (claims) => initialized.push(claims),
  });
  const server: HttpServer = createServer((req, res) => {
    void endpoint.handleRequest(req, res);
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolveP({
        port: addr.port,
        initialized,
        close: () =>
          new Promise<void>((r) => {
            endpoint.close();
            server.close(() => r());
          }),
      });
    });
  });
}

const GOOD_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  [PC_MCP_CLAIM_HEADERS.projectId]: 'proj-1',
  [PC_MCP_CLAIM_HEADERS.sessionId]: 'sess-1',
  [PC_MCP_CLAIM_HEADERS.agentSessionId]: 'cc-1',
  [PC_MCP_CLAIM_HEADERS.agentRunId]: '',
  [PC_MCP_CLAIM_HEADERS.dispatcherSessionId]: '',
  [PC_MCP_CLAIM_HEADERS.parentWorkItemId]: '',
  [PC_MCP_CLAIM_HEADERS.invokeDepth]: '0',
  [PC_MCP_TOKEN_HEADER]: 'good-token',
};

/** Pull the LAST `data:` JSON payload out of a JSON or SSE response body. */
function lastPayload(text: string): unknown {
  const dataLines = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  const raw = dataLines.length > 0 ? dataLines[dataLines.length - 1]! : text;
  return JSON.parse(raw);
}

test('HTTP endpoint boots, initializes, and serves TOOLS in registry order', async () => {
  const h = await startHarness();
  try {
    const initRes = await fetch(`http://127.0.0.1:${h.port}/api/mcp`, {
      method: 'POST',
      headers: GOOD_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke', version: '0' },
        },
      }),
    });
    assert.equal(initRes.status, 200);
    const sid = initRes.headers.get('mcp-session-id');
    assert.ok(sid, 'initialize response must carry mcp-session-id');
    await initRes.text(); // drain

    const notifyRes = await fetch(`http://127.0.0.1:${h.port}/api/mcp`, {
      method: 'POST',
      headers: { ...GOOD_HEADERS, 'mcp-session-id': sid! },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.ok(notifyRes.status < 300, `initialized notification accepted (${notifyRes.status})`);
    await notifyRes.text();

    // The ReadyGate handshake callback fired with THIS session's claims.
    assert.equal(h.initialized.length, 1);
    assert.equal(h.initialized[0]!.projectId, 'proj-1');
    assert.equal(h.initialized[0]!.agentSessionId, 'cc-1');

    const listRes = await fetch(`http://127.0.0.1:${h.port}/api/mcp`, {
      method: 'POST',
      headers: { ...GOOD_HEADERS, 'mcp-session-id': sid! },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(listRes.status, 200);
    const payload = lastPayload(await listRes.text()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    assert.deepEqual(
      payload.result?.tools?.map((t) => t.name),
      TOOLS.map((t) => t.name),
      'ListTools must serve the registry order',
    );
  } finally {
    await h.close();
  }
});

test('bad token → 401, no MCP session opened', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/mcp`, {
      method: 'POST',
      headers: { ...GOOD_HEADERS, [PC_MCP_TOKEN_HEADER]: 'forged' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke', version: '0' },
        },
      }),
    });
    assert.equal(res.status, 401);
    await res.text();
    assert.equal(h.initialized.length, 0);
  } finally {
    await h.close();
  }
});

test('unknown session id → 404 -32001 (the CC re-initialize signal)', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/mcp`, {
      method: 'POST',
      headers: { ...GOOD_HEADERS, 'mcp-session-id': 'gone-after-restart' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    });
    assert.equal(res.status, 404);
    const payload = (await res.json()) as { error?: { code?: number } };
    assert.equal(payload.error?.code, -32001);
  } finally {
    await h.close();
  }
});
