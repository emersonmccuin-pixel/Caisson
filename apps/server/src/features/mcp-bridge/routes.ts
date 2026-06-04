import type { Hono } from 'hono';
import type { AgentHostCommand, AgentHostCommandResponse } from '@pc/runtime';
import { TOOLS } from '@pc/mcp';

import { getActiveRunRegistry as defaultGetActiveRunRegistry } from '../../services/agent-active-runs.ts';

export interface McpBridgeRuntime {
  notifyOrchestratorMcpHandshake(agentSessionId: string): boolean;
}

export interface McpBridgeActiveRunRegistry {
  getByCcSession(
    ccSessionId: string,
  ): { run: { notifyMcpHandshake(): void } } | null;
}

export interface McpBridgeHostClient {
  sendCommand(
    command: AgentHostCommand,
  ): AgentHostCommandResponse | Promise<AgentHostCommandResponse> | void;
}

export interface McpBridgeRouteDeps {
  dataDir: string;
  resolveProject(projectId: string): McpBridgeRuntime | null;
  getActiveRunRegistry?: () => McpBridgeActiveRunRegistry;
  getHostClient?: () => McpBridgeHostClient | null;
}

export function registerMcpBridgeRoutes(app: Hono, deps: McpBridgeRouteDeps): void {
  // FD-2 — the tools server IS this process now (the shared /api/mcp endpoint),
  // so "is MCP alive" is answered live instead of via the dead stdio child's
  // heartbeat file. `?projectId=` is accepted for caller compat; the answer is
  // the same for every project — one endpoint serves them all.
  app.get('/api/mcp-status', (c) => {
    return c.json({
      alive: true,
      toolCount: TOOLS.length,
      tools: TOOLS.map((t) => t.name),
    });
  });

  const routeHandshake = createMcpHandshakeRouter(deps);

  /** Section 22 / Phase D — fired when CC's MCP client finishes the JSON-RPC
   *  handshake (the `initialized` notification). FD-2: the shared HTTP tools
   *  endpoint calls `createMcpHandshakeRouter` directly on initialize; this
   *  POST stays as the door for sessions spawned before the transport flip
   *  (their stdio children still post here until they exit). Routes the signal
   *  to whichever surface owns the session: the v2 active-runs registry, the
   *  out-of-process agent host, or the project orchestrator. */
  app.post('/api/internal/mcp-handshake', async (c) => {
    const body = await c.req.json<{ projectId?: string; agentSessionId?: string }>();
    if (!body.projectId || !body.agentSessionId) {
      return c.json({ ok: false, error: 'projectId + agentSessionId required' }, 400);
    }
    const result = await routeHandshake(body.projectId, body.agentSessionId);
    return c.json(result);
  });
}

export interface McpHandshakeResult {
  ok: true;
  found: boolean;
  transport?: 'agent' | 'host' | 'orchestrator';
}

/** THE handshake routing — one implementation behind both doors (the legacy
 *  POST above and the FD-2 shared HTTP endpoint's `oninitialized`). */
export function createMcpHandshakeRouter(
  deps: McpBridgeRouteDeps,
): (projectId: string, agentSessionId: string) => Promise<McpHandshakeResult> {
  const getActiveRunRegistry = deps.getActiveRunRegistry ?? defaultGetActiveRunRegistry;
  const getHostClient = deps.getHostClient ?? (() => null);
  return async (projectId, agentSessionId) => {
    const v2Entry = getActiveRunRegistry().getByCcSession(agentSessionId);
    if (v2Entry) {
      v2Entry.run.notifyMcpHandshake();
      return { ok: true, found: true, transport: 'agent' };
    }
    const hostClient = getHostClient();
    if (hostClient) {
      try {
        const response = await hostClient.sendCommand({
          type: 'notify-mcp-handshake',
          ccSessionId: agentSessionId,
        });
        if (response?.ok && response.command === 'notify-mcp-handshake') {
          return { ok: true, found: true, transport: 'host' };
        }
      } catch {
        // Best-effort: the orchestrator route below may still own this session.
      }
    }
    const runtime = deps.resolveProject(projectId);
    if (runtime?.notifyOrchestratorMcpHandshake(agentSessionId)) {
      return { ok: true, found: true, transport: 'orchestrator' };
    }
    return { ok: true, found: false };
  };
}
