import type { ULID } from '@/features/projects/types';

export type PodScope = 'global' | 'project';
export type PodOrigin = 'stock' | 'user-created';
export type PodKnowledgeKind = 'knowledge' | 'example';
export type PodAuditActor = 'orchestrator' | 'user';
export type PodAuditField =
  | 'prompt'
  | 'description'
  | 'model'
  | 'effort'
  | 'max_turns'
  | 'tools'
  // 'output_destination' — ☠ M5 (FD-5): column deleted; survives only in
  // historical audit rows.
  | 'output_destination'
  | 'name'
  | 'dispatch_guidance'
  | 'knowledge'
  | 'secret'
  | 'mcp_server'
  | 'scope'
  | 'created'
  | 'deleted';

export interface PodMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface Pod {
  id: ULID;
  name: string;
  scope: PodScope;
  projectId: ULID | null;
  prompt: string;
  tools: string[];
  model: string | null;
  effort: string | null;
  maxTurns: number | null;
  description: string;
  origin: PodOrigin;
  dispatchGuidance: string | null;
  driftedFields: string[] | null;
  /** UI Spine step 3 — monotonic write counter for version-aware WS patching. */
  rev: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface PodKnowledge {
  id: ULID;
  agentId: ULID;
  scope: PodScope;
  projectId: ULID | null;
  name: string;
  kind: PodKnowledgeKind;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface PodSecret {
  id: ULID;
  agentId: ULID;
  envVarName: string;
  createdAt: number;
}

export interface PodMcpServer {
  id: ULID;
  agentId: ULID;
  scope: PodScope;
  projectId: ULID | null;
  name: string;
  config: PodMcpServerConfig;
  createdAt: number;
}

export interface PodAuditEntry {
  id: ULID;
  agentId: ULID;
  changeSetId: ULID | null;
  actor: PodAuditActor;
  field: PodAuditField;
  fieldRef: string | null;
  priorValue: string | null;
  newValue: string | null;
  reason: string | null;
  createdAt: number;
}

export interface PodBundle {
  agent: Pod;
  knowledge: PodKnowledge[];
  secrets: PodSecret[];
  mcpServers: PodMcpServer[];
}

export interface CreatePodInput {
  name: string;
  scope?: 'project' | 'global';
  projectId?: ULID;
  description?: string;
  prompt?: string;
  model?: string | null;
  effort?: string | null;
  maxTurns?: number | null;
  tools?: string[];
}

export interface PatchPodInput {
  name?: string;
  description?: string;
  prompt?: string;
  model?: string | null;
  effort?: string | null;
  maxTurns?: number | null;
  tools?: string[];
}

export interface ListAuditOptions {
  limit?: number;
  beforeCreatedAt?: number;
  actor?: PodAuditActor;
  field?: PodAuditField;
}

export function resolveModelLabel(model: string | null | undefined): string {
  if (!model || model === 'inherit') return 'opus';
  return model;
}
