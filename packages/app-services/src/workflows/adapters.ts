// Compatibility adapters for the workflow family (slice 004).
//
// Pure mappers between the db `WorkflowRunV2Record` / domain WorkflowV2 shapes
// and the shared @pc/contracts DTOs. The run already freezes its graph in
// `workflowYamlSnapshot`; `toWorkflowRunDto` surfaces a `definitionHash` derived
// from that snapshot (sha256, matching the definitions table's yaml_hash
// convention) so a run is traceable to the exact definition content it ran.
// Boundary purity: @pc/contracts + @pc/domain + node:crypto only.

import { createHash } from 'node:crypto';
import type {
  WorkflowDagStateDto,
  WorkflowDefinitionDto,
  WorkflowRunDto,
} from '@pc/contracts';
import type { WorkflowRunV2Record } from '@pc/db';
import type { WorkflowV2 } from '@pc/domain';

/** The subset of a `workflows` row this slice surfaces as a DTO. Structurally
 *  matches the @pc/db `workflows` table select shape (drizzle camelCase keys). */
export interface WorkflowDefinitionRowLike {
  id: string;
  slug: string;
  scope: 'global' | 'project';
  projectId: string | null;
  name: string;
  displayName: string | null;
  description: string | null;
  status: 'active' | 'invalid';
  disabled: boolean;
  yamlHash: string | null;
  updatedAt: number;
}

export class WorkflowAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowAdapterError';
  }
}

/** sha256 of the frozen snapshot — the run's definition fingerprint. */
export function definitionHashOf(workflowYamlSnapshot: string): string {
  return createHash('sha256').update(workflowYamlSnapshot, 'utf8').digest('hex');
}

/** WorkflowV2.WorkflowDagState → DTO. Same structural shape; this is a typed
 *  passthrough that keeps the browser contract decoupled from the domain. */
export function toWorkflowDagStateDto(state: WorkflowV2.WorkflowDagState): WorkflowDagStateDto {
  const dto: WorkflowDagStateDto = { nodes: { ...state.nodes } };
  if (state.rejectIterations !== undefined) dto.rejectIterations = { ...state.rejectIterations };
  if (state.rejectFeedback !== undefined) dto.rejectFeedback = { ...state.rejectFeedback };
  return dto;
}

export function toWorkflowDefinitionDto(row: WorkflowDefinitionRowLike): WorkflowDefinitionDto {
  if (!row || typeof row.id !== 'string') {
    throw new WorkflowAdapterError('invalid workflow definition row: missing id');
  }
  return {
    id: row.id,
    slug: row.slug,
    scope: row.scope,
    projectId: row.projectId,
    name: row.name,
    displayName: row.displayName ?? null,
    description: row.description ?? null,
    status: row.status,
    disabled: row.disabled,
    yamlHash: row.yamlHash ?? null,
    updatedAt: row.updatedAt,
  };
}

export function toWorkflowRunDto(run: WorkflowRunV2Record): WorkflowRunDto {
  if (!run || typeof run.id !== 'string') {
    throw new WorkflowAdapterError('invalid workflow run row: missing id');
  }
  return {
    id: run.id,
    projectId: run.projectId,
    workflowSlug: run.workflowId,
    workflowName: run.workflowName,
    definitionHash: definitionHashOf(run.workflowYamlSnapshot),
    status: run.status,
    rev: run.rev,
    workItemId: run.workItemId,
    worktreePath: run.worktreePath,
    lastReason: run.lastReason,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    dagState: toWorkflowDagStateDto(run.dagState),
  };
}
