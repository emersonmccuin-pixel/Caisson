// pc-pty-chat-359 P1 — MCP Server Registry frontend types.

export type McpDiscoveryStatus = 'ok' | 'failed' | 'stale';
export type McpServerScope = 'global' | 'project';

/** A transport header or env value in its stored form: either a plain string
 *  or a vault reference. The boot-time migration converts all plaintext
 *  header/env values to SecretRefs; the UI masks them as •••••••• and rounds
 *  them trip correctly without overwriting the vaulted credential. */
export type TransportValue = string | { $secretRef: string };

/** Transport shape — matches the server-side McpServerTransport. */
export interface McpTransport {
  /** stdio: executable to run */
  command?: string;
  args?: string[];
  /** stdio: env vars; values may be plain strings or vault refs (masked ••••••••). */
  env?: Record<string, TransportValue>;
  /** stdio: working directory the server launches from (optional) */
  cwd?: string;
  /** HTTP: transport type ('http', 'sse') */
  type?: string;
  /** HTTP: endpoint URL */
  url?: string;
  /** HTTP: request headers; values may be plain strings or vault refs (masked ••••••••). */
  headers?: Record<string, TransportValue>;
  /** OC (pc-pty-chat-460) — when 'oauth', the server uses OAuth 2.1 + PKCE.
   *  The UI renders an Authorize button; consent happens interactively in the
   *  system browser before any spawn. */
  authType?: 'oauth';
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
  /** OC (pc-pty-chat-460) — OAuth credential lifecycle state. Surfaced by the
   *  GET routes from the linked `oauth_tokens` credential row. Null when no
   *  credential exists yet (server never authorized). */
  authState?: string | null;
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
