import type { Hono } from 'hono';
import type { ULID } from '@pc/domain';
import type { AgentHostCommand, AgentHostCommandResponse } from '@pc/runtime';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  now?: () => number;
  readFileText?: (path: string) => string | null;
  getActiveRunRegistry?: () => McpBridgeActiveRunRegistry;
  getHostClient?: () => McpBridgeHostClient | null;
}

function defaultReadFileText(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

export function registerMcpBridgeRoutes(app: Hono, deps: McpBridgeRouteDeps): void {
  const services = {
    now: deps.now ?? Date.now,
    readFileText: deps.readFileText ?? defaultReadFileText,
    getActiveRunRegistry: deps.getActiveRunRegistry ?? defaultGetActiveRunRegistry,
    getHostClient: deps.getHostClient ?? (() => null),
  };

  // MCP heartbeats are written per-project by `packages/mcp/src/server.ts`
  // (`PC_PROJECT_ID` is supplied in PC's session-local MCP env). Pass
  // `?projectId=` to read that project's heartbeat; the legacy global path is
  // the fallback for pre-per-project clients.
  app.get('/api/mcp-status', (c) => {
    const projectId = c.req.query('projectId');
    const file = projectId
      ? resolve(deps.dataDir, 'projects', projectId, 'mcp-status.json')
      : resolve(deps.dataDir, 'mcp-status.json');
    const text = services.readFileText(file);
    if (text === null) return c.json({ alive: false, toolCount: 0, tools: [] });
    try {
      const raw = JSON.parse(text) as {
        aliveAt?: string;
        toolCount?: number;
        tools?: string[];
      };
      const aliveAtMs = raw.aliveAt ? Date.parse(raw.aliveAt) : 0;
      const alive = Number.isFinite(aliveAtMs) && services.now() - aliveAtMs < 8000;
      return c.json({
        alive,
        toolCount: alive ? raw.toolCount ?? 0 : 0,
        tools: alive ? raw.tools ?? [] : [],
      });
    } catch {
      return c.json({ alive: false, toolCount: 0, tools: [] });
    }
  });

  /** Section 22 / Phase D -- internal endpoint posted by pc-rig (the per-spawn
   *  MCP child) when CC's MCP client finishes the JSON-RPC handshake (the
   *  `initialized` notification). Routes the signal to whichever surface owns
   *  the session: the v2 active-runs registry (in-process dispatched agents),
   *  the out-of-process agent host, or the project orchestrator. */
  app.post('/api/internal/mcp-handshake', async (c) => {
    const body = await c.req.json<{ projectId?: string; agentSessionId?: string }>();
    if (!body.projectId || !body.agentSessionId) {
      return c.json({ ok: false, error: 'projectId + agentSessionId required' }, 400);
    }
    const v2Entry = services.getActiveRunRegistry().getByCcSession(body.agentSessionId);
    if (v2Entry) {
      v2Entry.run.notifyMcpHandshake();
      return c.json({ ok: true, found: true, transport: 'agent' });
    }
    const hostClient = services.getHostClient();
    if (hostClient) {
      try {
        const response = await hostClient.sendCommand({
          type: 'notify-mcp-handshake',
          ccSessionId: body.agentSessionId,
        });
        if (response?.ok && response.command === 'notify-mcp-handshake') {
          return c.json({ ok: true, found: true, transport: 'host' });
        }
      } catch {
        // Best-effort: local/orchestrator routes below may still own this session.
      }
    }
    const runtime = deps.resolveProject(body.projectId);
    if (runtime?.notifyOrchestratorMcpHandshake(body.agentSessionId)) {
      return c.json({ ok: true, found: true, transport: 'orchestrator' });
    }
    return c.json({ ok: true, found: false });
  });
}
