// pc-pty-chat-359 P1 — MCP Server Registry frontend types.

export type McpDiscoveryStatus = 'ok' | 'failed' | 'stale';
export type McpServerScope = 'global' | 'project';

/** Transport shape — matches the server-side PodMcpServerConfig. */
export interface McpTransport {
  /** stdio: executable to run */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** stdio: working directory the server launches from (optional) */
  cwd?: string;
  /** HTTP: endpoint URL */
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServer {
  id: string;
  scope: McpServerScope;
  projectId: string | null;
  name: string;
  description: string;
  transport: McpTransport;
  discoveredTools: string[] | null;
  discoveryStatus: McpDiscoveryStatus;
  rev: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface CreateMcpServerInput {
  name: string;
  description?: string;
  transport: McpTransport;
}

export interface PatchMcpServerInput {
  name?: string;
  description?: string;
  transport?: McpTransport;
}

// ── Agent MCP Attachments (P3) ────────────────────────────────────────────────

/** Links an agent to a registry MCP server with a per-tool selection.
 *  `enabledTools === '*'` = all discovered tools; array = specific subset. */
export interface AgentMcpAttachment {
  id: string;
  agentId: string;
  mcpServerId: string;
  /** `'*'` = all tools; string array = chosen subset. */
  enabledTools: string[] | '*';
  createdAt: number;
  updatedAt: number;
}

export interface UpsertMcpAttachmentInput {
  enabledTools: string[] | '*';
}
