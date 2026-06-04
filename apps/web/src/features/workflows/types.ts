import type { ULID } from '@/features/projects/types';

export type CatalogType =
  | 'ulid'
  | 'string'
  | 'text'
  | 'int'
  | 'bool'
  | 'object'
  | 'array';

export type NodeOutputStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface NodeOutput {
  status: NodeOutputStatus;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  attempt?: number;
  transcriptPath?: string;
}

export interface V2WorkflowDefSummary {
  id: string;
  name: string;
  description?: string;
  nodes: Array<{ id: string; kind: string }>;
  disabled?: boolean;
}

export type V2RunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface V2RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  projectId: string;
  workItemId: string | null;
  status: V2RunStatus;
  worktreePath: string | null;
  lastReason: string | null;
  /** Monotonic write counter from the DB. Used by the version-aware store to
   *  discard out-of-order / duplicate WS deltas. */
  rev: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface V2RunDetail extends V2RunSummary {
  dagState: {
    nodes: Record<
      string,
      {
        state: string;
        workItemId?: string;
        iteration?: number;
        error?: string;
        startedAt?: number;
        endedAt?: number;
      }
    >;
    rejectIterations?: Record<string, number>;
    rejectFeedback?: Record<string, string>;
  };
  workflowYamlSnapshot: string;
  metadata: Record<string, unknown>;
  lastActivityAt: number | null;
}

export interface V2RunEvent {
  id: string;
  runId: string;
  type: string;
  nodeId: string | null;
  data: Record<string, unknown> | null;
  /** Epoch ms (the server's `at` column — was misnamed `occurredAt` while the
   *  UI still discarded events; fixed when the M3a diary timeline landed). */
  at: number;
}

export interface WorkflowFireResult {
  ok: true;
  runId: string;
  rootWorkItemId: string;
}

export type V2WorkflowDef = V2WorkflowDefSummary & { [key: string]: unknown };

export type WorkflowScope = 'global' | 'project';
export type WorkflowOrigin = 'stock' | 'user-created';
export type WorkflowRowStatus = 'active' | 'invalid';

export interface WorkflowRow {
  id: ULID;
  scope: WorkflowScope;
  projectId: ULID | null;
  slug: string;
  name: string;
  displayName: string | null;
  description: string | null;
  yaml: string;
  yamlHash: string;
  parsedDefinition: V2WorkflowDef | null;
  status: WorkflowRowStatus;
  parseError: string | null;
  disabled: boolean;
  origin: WorkflowOrigin;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}
