// pc-pty-chat-359 P1/P2 — MCP Server Registry API client.

import { getJson, postJson, postJsonMethod } from '@/api/http';
import type {
  AgentMcpAttachment,
  CreateMcpServerInput,
  McpServer,
  PatchMcpServerInput,
  UpsertMcpAttachmentInput,
} from './types';

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

  /** OC (pc-pty-chat-460): start the OAuth consent flow for an HTTP server.
   *  Returns { status: 'authorized' } when tokens are already valid, or
   *  { status: 'redirect', authorizationUrl } when the user must authorize in
   *  the system browser. */
  startAuth: (id: string) =>
    postJson<
      | { ok: true; status: 'authorized' }
      | { ok: true; status: 'redirect'; authorizationUrl: string }
    >(`/api/mcp-servers/${id}/auth/start`, {}).then((r) => r),

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

// ── Orchestrator pod resolution (P4a) ────────────────────────────────────────

/** Resolve the agentId of the pod driving this project's orchestrator chat. */
export const orchestratorPodApi = {
  getAgentId: (projectId: string) =>
    getJson<{ ok: true; agentId: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/orchestrator-pod`,
    ).then((r) => r.agentId),
};

// ── Agent MCP Attachment API (P3) ─────────────────────────────────────────────

export const mcpAttachmentsApi = {
  /** List all registry server attachments for an agent. */
  listForAgent: (agentId: string) =>
    getJson<{ ok: true; attachments: AgentMcpAttachment[] }>(
      `/api/agents/pods/${agentId}/mcp-attachments`,
    ).then((r) => r.attachments),

  /** Attach a registry server to an agent, or update its tool selection.
   *  Idempotent — calling again with a different selection updates in-place. */
  upsert: (agentId: string, mcpServerId: string, input: UpsertMcpAttachmentInput) =>
    postJsonMethod<{ ok: true; attachment: AgentMcpAttachment }>(
      `/api/agents/pods/${agentId}/mcp-attachments/${mcpServerId}`,
      input,
      'PUT',
    ).then((r) => r.attachment),

  /** Detach a registry server from an agent. Idempotent — safe if not attached. */
  detach: async (agentId: string, mcpServerId: string): Promise<void> => {
    const res = await fetch(
      `/api/agents/pods/${agentId}/mcp-attachments/${mcpServerId}`,
      { method: 'DELETE' },
    );
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error ?? `detach mcp attachment → ${res.status}`);
    }
  },
};
