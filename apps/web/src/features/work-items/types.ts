import type { ULID } from '@/features/projects/types';

export type WorkItemStatus =
  | 'pending'
  | 'in-progress'
  | 'awaiting-verification'
  | 'blocked'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'archived';

export type InitiativeStatus = 'active' | 'someday' | 'done' | 'archived';
export type InitiativeFocusState = 'focused' | 'normal';
export type InitiativeNoteKind = 'capture' | 'context' | 'decision';

export interface Initiative {
  id: ULID;
  projectId: ULID;
  name: string;
  brief: string;
  status: InitiativeStatus;
  focusState: InitiativeFocusState;
  position: number;
  sourceVersion: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface InitiativeNote {
  id: ULID;
  initiativeId: ULID;
  kind: InitiativeNoteKind;
  body: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export const WORK_ITEM_TYPES = ['task', 'bug', 'feature', 'spike'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export interface WorkItemHistoryEntry {
  ts: string;
  kind:
    | 'move'
    | 'update'
    | 'agent-invoke'
    | 'agent-ask-orchestrator'
    | 'agent-ask-user'
    | 'agent-approval-request'
    | 'agent-answer'
    | 'agent-completed'
    | 'agent-failed';
  from?: string;
  to?: string;
  fields?: Record<string, unknown>;
  note?: string;
  agentName?: string;
  sessionId?: string;
  runId?: string;
  pendingAskId?: string;
  invokeMode?: 'sync' | 'async';
  answeredBy?: 'orchestrator' | 'user';
  cause?: string;
}

export interface WorkItem {
  id: ULID;
  projectId: ULID;
  parentId: ULID | null;
  initiativeId: ULID | null;
  areaId: ULID | null;
  position: number;
  title: string;
  body: string;
  stageId: string;
  status: WorkItemStatus;
  statusReason: string | null;
  type: WorkItemType;
  fields: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  history: WorkItemHistoryEntry[];
  isAgentTask: boolean;
  callsign: string | null;
}

export type FieldSchemaType = 'text' | 'number' | 'boolean' | 'enum' | 'date';

export interface FieldSchema {
  id: ULID;
  projectId: ULID;
  key: string;
  label: string;
  type: FieldSchemaType;
  options?: string[];
  default?: unknown;
  required: boolean;
  description?: string;
  order: number;
}

export interface FieldSchemaInput {
  id?: ULID;
  key: string;
  label: string;
  type: FieldSchemaType;
  options?: string[];
  default?: unknown;
  required: boolean;
  description?: string;
  order: number;
}

export interface Attachment {
  id: ULID;
  workItemId: ULID;
  kind: string;
  name: string;
  content: string;
  contentType: string | null;
  runId: ULID | null;
  createdBySessionId: ULID | null;
  createdAt: number;
}

export interface WorkItemPatch {
  title?: string;
  body?: string;
  stageId?: string;
  parentId?: ULID | null;
  initiativeId?: ULID | null;
  areaId?: ULID | null;
  position?: number;
  type?: WorkItemType;
  fields?: Record<string, unknown>;
}

export interface WorkItemMoveInput {
  stageId: string;
  position?: number;
}

export class WorkItemConflictError extends Error {
  current: WorkItem;
  constructor(current: WorkItem) {
    super('work item version conflict');
    this.name = 'WorkItemConflictError';
    this.current = current;
  }
}

export class StageHasItemsError extends Error {
  orphans: { id: string; name: string; count: number }[];
  constructor(orphans: { id: string; name: string; count: number }[]) {
    super('STAGE_HAS_ITEMS');
    this.name = 'StageHasItemsError';
    this.orphans = orphans;
  }
}

export class WorkItemFieldValidationError extends Error {
  errors: Record<string, string>;
  constructor(message: string, errors: Record<string, string>) {
    super(message);
    this.name = 'WorkItemFieldValidationError';
    this.errors = errors;
  }
}
