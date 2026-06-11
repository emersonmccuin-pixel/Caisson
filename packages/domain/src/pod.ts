// Section 17 — Agent pods (DB-resident specialists).
//
// Pods are the long-lived storage shape for an agent: prompt + tools + model
// settings live in `agents`; per-pod content lives in `agent_secrets`,
// `agent_mcp_servers`, and agent-scoped `context_docs` rows (migration 0055
// merged the old agent_knowledge table into the unified context-doc store).
// Every mutation writes an `agent_audit` row for the History tab + revert.
//
// All content tables carry `scope` + `project_id` from v1 even though v1 is
// global-only — so 17c (per-project overlay) lands without a schema migration.
//
// File-backed `AgentDef` (see `agent.ts`) is a separate shape PC still reads
// when materialising the pod to disk for `claude.exe`. Pod tables are the
// source of truth; the .md file is rendered fresh per spawn.

import type { AgentEffort, AgentModel } from './agent.ts';
import type { ExpectedOutput } from './contract.ts';
import type { ULID } from './ulid.ts';

export type PodScope = 'global' | 'project';

export const POD_SCOPES: readonly PodScope[] = ['global', 'project'];

export type PodAuditActor = 'orchestrator' | 'user';

export const POD_AUDIT_ACTORS: readonly PodAuditActor[] = ['orchestrator', 'user'];

/** Audit `field` discriminates which slice of the pod changed. `field_ref`
 *  disambiguates list-shaped fields — e.g. for `context-doc` it's the doc id,
 *  for `secret` it's the env-var name, for `mcp_server` it's the server name.
 *  Scalar fields on the `agents` row use `field_ref = null`. */
export type PodAuditField =
  | 'prompt'
  | 'description'
  | 'model'
  | 'effort'
  | 'max_turns'
  | 'tools'
  // 'output_destination' — ☠ M5 (FD-5): the column is deleted; the literal
  // survives ONLY in historical audit rows, which keep rendering as-is.
  | 'output_destination'
  | 'name'
  | 'dispatch_guidance'
  // 'knowledge' — ☠ migration 0055 (knowledge merged into context_docs); the
  // literal survives ONLY in historical audit rows, which keep rendering as-is.
  | 'knowledge'
  /** Agent-scoped context doc edits (migration 0055+). fieldRef = doc id. */
  | 'context-doc'
  | 'secret'
  | 'mcp_server'
  | 'scope'
  | 'created'
  | 'deleted';

export const POD_AUDIT_FIELDS: readonly PodAuditField[] = [
  'prompt',
  'description',
  'model',
  'effort',
  'max_turns',
  'tools',
  'output_destination',
  'name',
  'dispatch_guidance',
  'knowledge',
  'context-doc',
  'secret',
  'mcp_server',
  'scope',
  'created',
  'deleted',
];

/** Inline MCP server config stored on `agent_mcp_servers.config_json`.
 *  Mirrors the on-disk `.mcp.json` `mcpServers` value shape — `command + args
 *  + env` for stdio, `type:'http' + url + headers` for HTTP (FD-2: the pc-rig
 *  baseline is an HTTP entry). Validated at materialisation time. */
export interface PodMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** Provenance of an agent row. `'stock'` rows are seeded by PC at boot;
 *  `'user-created'` rows came from any other path (orchestrator dispatch,
 *  agent-designer, UI, MCP `pc_create_agent`). Section 36 — replaces the
 *  multi-list "is this pod stock?" pattern; route-layer protection reads
 *  this column. */
export type PodOrigin = 'stock' | 'user-created';

/** Row in the `agents` table. Scalar settings + tools allowlist; per-pod
 *  content lives in the child tables. */
export interface PodAgentRow {
  id: ULID;
  name: string;
  scope: PodScope;
  /** Null when `scope === 'global'`. Set to the owning project id when
   *  `scope === 'project'`. */
  projectId: ULID | null;
  prompt: string;
  /** Allowlist of tool names (exact match — `mcp__server__*` wildcards are
   *  expanded by the materialiser, NOT stored expanded). */
  tools: string[];
  model: AgentModel | null;
  effort: AgentEffort | null;
  maxTurns: number | null;
  description: string;
  /** Section 36 — `'stock'` vs `'user-created'`. Stock pods can't be deleted
   *  or edited via user-facing routes (route-layer guard reads this column). */
  origin: PodOrigin;
  /** Section 36 — orchestrator-facing "when to dispatch this agent" hint,
   *  rendered into the orchestrator's `{{AVAILABLE_AGENTS}}` variable. Null
   *  for most user-created pods (their `description` is enough). */
  dispatchGuidance: string | null;
  /** Section 26 Issue #3 — default expected_output for this pod. When set,
   *  createAgentWorkItem uses this before falling back to the stock map in
   *  pod-defaults.ts. Null for stock pods (they use the hardcoded map) and
   *  for user-created pods that haven't declared a default. */
  expectedOutput: ExpectedOutput | null;
  /** UI Spine step 3 — monotonic write counter. Incremented by every
   *  mutating write; the pod write-door stamps WS deltas so the frontend
   *  can discard stale/duplicate envelopes. */
  rev: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** Agent-scoped context doc as the spawn bundle / materialiser consume it.
 *  Thin projection of a `context_docs` row (scope pointer = agent_id) —
 *  @pc/runtime cannot import @pc/db, so the shape lives here. */
export interface AgentContextDoc {
  id: ULID;
  title: string;
  body: string;
  updatedAt: number;
}

export interface PodSecretRow {
  id: ULID;
  agentId: ULID;
  scope: PodScope;
  projectId: ULID | null;
  envVarName: string;
  /** v1: plaintext. v2 will swap to `encrypted_value` (DPAPI). */
  valuePlaintext: string;
  createdAt: number;
}

export interface PodMcpServerRow {
  id: ULID;
  agentId: ULID;
  scope: PodScope;
  projectId: ULID | null;
  name: string;
  config: PodMcpServerConfig;
  createdAt: number;
}

export interface PodAuditRow {
  id: ULID;
  agentId: ULID;
  /** Groups multi-field edits (e.g. an orchestrator change-set touching
   *  prompt + 2 knowledge docs in one transaction). Null for solo edits. */
  changeSetId: ULID | null;
  actor: PodAuditActor;
  field: PodAuditField;
  /** Disambiguator for list-shaped fields (knowledge row id, secret env-var
   *  name, mcp server name). Null for scalar fields. */
  fieldRef: string | null;
  /** Pre-edit value as JSON-or-text. Always NULL for `secret` rows
   *  (secrets log event-only — values never hit the audit table). */
  priorValue: string | null;
  newValue: string | null;
  reason: string | null;
  createdAt: number;
}

/** Aggregate read shape the materialiser (17a.3) consumes.
 *  MCP servers are no longer inline — they are resolved from the registry
 *  via agent_mcp_attachments at spawn time (pc-pty-chat-359 P4b). */
export interface PodSpawnBundle {
  agent: PodAgentRow;
  contextDocs: AgentContextDoc[];
  secrets: PodSecretRow[];
}

// ── MCP Agent Attachments (P3 — pc-pty-chat-359.3) ───────────────────────────

/** A single attachment linking an agent to a registry MCP server, with a
 *  per-tool selection. `enabledTools === '*'` grants all discovered tools;
 *  an array restricts to the listed tool names. */
export interface AgentMcpAttachmentRow {
  id: ULID;
  agentId: ULID;
  mcpServerId: ULID;
  /** `'*'` = all tools; `string[]` = specific subset. */
  enabledTools: string[] | '*';
  createdAt: number;
  updatedAt: number;
}

// ── Credentials vault (Slice 1 — pc-pty-chat-400.2) ─────────────────────────

/** What the encrypted blob holds. */
export type CredentialKind = 'oauth_tokens' | 'provider_tokens' | 'static';

/** Auth lifecycle state for a stored credential. */
export type CredentialAuthState = 'none' | 'needs-auth' | 'connected' | 'expired' | 'error';

export const CREDENTIAL_AUTH_STATES: readonly CredentialAuthState[] = [
  'none',
  'needs-auth',
  'connected',
  'expired',
  'error',
];

/** Row in the `credentials` table — AES-256-GCM encrypted token blob. */
export interface CredentialRow {
  id: ULID;
  ownerScope: 'global' | 'project';
  /** FK to `mcp_servers.id`. Nullable — credential may not yet be bound to a
   *  server (e.g. during initial OAuth flow). */
  ownerServerId: ULID | null;
  kind: CredentialKind;
  /** Base64-encoded ciphertext. */
  ciphertext: string;
  /** Base64-encoded 12-byte IV. */
  iv: string;
  /** Base64-encoded 16-byte GCM auth tag. */
  authTag: string;
  authState: CredentialAuthState;
  lastError: string | null;
  /** Epoch-ms token expiry, or null for non-expiring credentials. */
  expiresAt: number | null;
  rev: number;
  createdAt: number;
  updatedAt: number;
}

// ── MCP Server Registry (P1 — pc-pty-chat-359) ───────────────────────────────

/** Discovery lifecycle for a registry server entry. `stale` = never probed or
 *  needs re-probe; `ok` = tools list cached; `failed` = last probe errored. */
export type McpDiscoveryStatus = 'ok' | 'failed' | 'stale';

export const MCP_DISCOVERY_STATUSES: readonly McpDiscoveryStatus[] = ['ok', 'failed', 'stale'];

/** Row in the `mcp_servers` registry table. Scope mirrors agents: global rows
 *  are shared across all projects; project rows are project-local. `transport`
 *  carries the same stdio/HTTP shape as `agent_mcp_servers.config_json`. */
export interface McpServerRegistryRow {
  id: ULID;
  scope: PodScope;
  /** Null when `scope === 'global'`; set when `scope === 'project'`. */
  projectId: ULID | null;
  name: string;
  description: string;
  /** Stdio: command + optional args/env. HTTP: url + optional headers. */
  transport: PodMcpServerConfig;
  /** Cached tool list from the last successful discovery probe. Null until P2. */
  discoveredTools: string[] | null;
  discoveryStatus: McpDiscoveryStatus;
  rev: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}
