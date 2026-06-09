// pc-pty-chat-359 P1 — MCP Server Registry frontend types.

export type McpDiscoveryStatus = 'ok' | 'failed' | 'stale';
export type McpServerScope = 'global' | 'project';

/** Transport shape — matches the server-side PodMcpServerConfig. */
export interface McpTransport {
  /** stdio: executable to run */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
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
