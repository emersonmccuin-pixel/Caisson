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
  // ☠ Cleanup sweep (2026-06-04) — writerless agent-* kinds deleted (mirrors
  // @pc/domain WorkItemHistoryEntry; only agent-audit.ts writes agent-invoke).
  kind: 'move' | 'update' | 'agent-invoke';
  from?: string;
  to?: string;
  fields?: Record<string, unknown>;
  note?: string;
  agentName?: string;
  sessionId?: string;
  runId?: string;
  invokeMode?: 'sync' | 'async';
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
  callsign: string | null;
  /** Command focus — epoch-ms the planner starred this item; null = not in focus. */
  focusedAt: number | null;
}

/** Slim projection returned by the work-item list endpoint when `includeBody`
 *  is NOT set (mirrors the server's `toSlimWorkItem` / `WorkItemSlim` in
 *  `@pc/domain`). Lacks `body`, `history`, `fields`, and other bulky columns.
 *
 *  Use this type for any fetch that omits `?includeBody=1`. It is structurally
 *  incompatible with `WorkItem` (no required `body` field) so the compiler goes
 *  red if a slim object is passed to something that expects the full shape. */
export interface WorkItemSummary {
  id: ULID;
  projectId: ULID;
  parentId: ULID | null;
  areaId: ULID | null;
  stageId: string;
  title: string;
  type: WorkItemType;
  status: WorkItemStatus;
  statusReason: string | null;
  callsign: string | null;
  updatedAt: number;
  /** Command focus — epoch-ms the planner starred this item; null = not in focus. */
  focusedAt: number | null;
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

/** pc-pty-chat-434 — agent dossier row as returned by
 *  GET /api/projects/:projectId/work-items/:wiId/dossier.
 *  `createdAt`/`updatedAt` are null when `fresh=true` (no DB row exists yet). */
export interface DossierRow {
  workItemId: ULID;
  state: string;
  decisions: string;
  openQuestions: string;
  updatedByRunId: ULID | null;
  updatedByAgent: string | null;
  version: number;
  createdAt: number | null;
  updatedAt: number | null;
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
