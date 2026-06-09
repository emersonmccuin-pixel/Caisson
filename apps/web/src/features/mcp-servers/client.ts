// pc-pty-chat-359 P1/P2 — MCP Server Registry API client.

import { getJson, postJson, postJsonMethod } from '@/api/http';
import type { CreateMcpServerInput, McpServer, PatchMcpServerInput } from './types';

export * from './types';

export const mcpServersApi = {
  // Global scope
  listGlobal: () =>
    getJson<{ ok: true; servers: McpServer[] }>('/api/mcp-servers').then((r) => r.servers),

  getServer: (id: string) =>
    getJson<{ ok: true; server: McpServer }>(`/api/mcp-servers/${id}`).then((r) => r.server),

  createGlobal: (input: CreateMcpServerInput) =>
    postJson<{ ok: true; server: McpServer }>('/api/mcp-servers', input).then((r) => r.server),

  patchServer: (id: string, patch: PatchMcpServerInput) =>
    postJsonMethod<{ ok: true; server: McpServer }>(`/api/mcp-servers/${id}`, patch, 'PATCH').then(
      (r) => r.server,
    ),

  deleteServer: async (id: string): Promise<void> => {
    const res = await fetch(`/api/mcp-servers/${id}`, { method: 'DELETE' });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `delete mcp server → ${res.status}`);
    }
  },

  /** P2: trigger a discovery probe and return the updated server row. */
  probeServer: (id: string) =>
    postJson<{ ok: true; server: McpServer }>(`/api/mcp-servers/${id}/probe`, {}).then(
      (r) => r.server,
    ),

  // Project scope
  listForProject: (projectId: string) =>
    getJson<{ ok: true; servers: McpServer[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers`,
    ).then((r) => r.servers),

  createForProject: (projectId: string, input: CreateMcpServerInput) =>
    postJson<{ ok: true; server: McpServer }>(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers`,
      input,
    ).then((r) => r.server),
};
