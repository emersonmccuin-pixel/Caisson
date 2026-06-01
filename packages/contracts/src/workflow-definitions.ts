// Workflow definition contract family (slice 004). Browser-safe, zero runtime deps.
//
// Owns the shared `WorkflowDefinitionDto` (the rail/detail surface — the graph
// YAML stays server-side) and the canonical `workflow.definition.changed`
// live-event payload + guards. Definition events follow the row's scope
// (global rows fan to all projects, mirroring today's broadcastAll). Mirrors
// the helper trio (build*/is*/to*) in projects.ts / work-items.ts.

import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
  type LiveEventFrame,
} from './live-events.ts';
import type { ULID } from './shared.ts';

export type WorkflowScope = 'global' | 'project';
export type WorkflowDefinitionStatus = 'active' | 'invalid';

export interface WorkflowDefinitionDto {
  id: string;
  slug: string;
  scope: WorkflowScope;
  projectId: ULID | null;
  name: string;
  displayName: string | null;
  description: string | null;
  status: WorkflowDefinitionStatus;
  disabled: boolean;
  yamlHash: string | null;
  updatedAt: number;
}

export type WorkflowDefinitionChange = 'created' | 'updated' | 'deleted';

export interface WorkflowDefinitionChangedLivePayload {
  change: WorkflowDefinitionChange;
  definition?: WorkflowDefinitionDto;
  /** Present on delete envelopes (mirrors the current deletedEnvelope shape). */
  workflowId?: string;
}


export type WorkflowDefinitionChangedLiveEvent = LiveEvent<WorkflowDefinitionChangedLivePayload> & {
  type: 'workflow.definition.changed';
  entity: 'workflow-definition';
};

export type WorkflowDefinitionChangedLiveEventFrame =
  LiveEventFrame<WorkflowDefinitionChangedLivePayload> & {
    event: WorkflowDefinitionChangedLiveEvent;
  };

export function isWorkflowScope(value: unknown): value is WorkflowScope {
  return value === 'global' || value === 'project';
}

export function isWorkflowDefinitionStatus(value: unknown): value is WorkflowDefinitionStatus {
  return value === 'active' || value === 'invalid';
}

export function isWorkflowDefinitionChange(value: unknown): value is WorkflowDefinitionChange {
  return value === 'created' || value === 'updated' || value === 'deleted';
}

export function isWorkflowDefinitionDto(value: unknown): value is WorkflowDefinitionDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.slug === 'string' &&
    isWorkflowScope(value.scope) &&
    (value.projectId === null || typeof value.projectId === 'string') &&
    typeof value.name === 'string' &&
    (value.displayName === null || typeof value.displayName === 'string') &&
    (value.description === null || typeof value.description === 'string') &&
    isWorkflowDefinitionStatus(value.status) &&
    typeof value.disabled === 'boolean' &&
    (value.yamlHash === null || typeof value.yamlHash === 'string') &&
    typeof value.updatedAt === 'number'
  );
}

export function isWorkflowDefinitionChangedLivePayload(
  value: unknown,
): value is WorkflowDefinitionChangedLivePayload {
  if (!isRecord(value) || !isWorkflowDefinitionChange(value.change)) return false;
  if (value.definition !== undefined && !isWorkflowDefinitionDto(value.definition)) return false;
  if (value.workflowId !== undefined && typeof value.workflowId !== 'string') return false;
  return true;
}

export function isWorkflowDefinitionChangedLiveEvent(
  value: unknown,
): value is WorkflowDefinitionChangedLiveEvent {
  return (
    isLiveEvent(value) &&
    value.type === 'workflow.definition.changed' &&
    value.entity === 'workflow-definition' &&
    isWorkflowDefinitionChangedLivePayload(value.payload)
  );
}

export function isWorkflowDefinitionChangedLiveEventFrame(
  value: unknown,
): value is WorkflowDefinitionChangedLiveEventFrame {
  return isLiveEventFrame(value) && isWorkflowDefinitionChangedLiveEvent(value.event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
