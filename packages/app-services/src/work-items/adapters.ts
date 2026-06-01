// Compatibility adapters for the work-item family (slice 003).
//
// Pure, bidirectional mappers between domain/db rows and the shared
// @pc/contracts DTOs. They tolerate optional/missing legacy fields, fail
// loud on structurally invalid input (no silent coercion of malformed rows),
// and provide a list-shape normalizer so both the no-filter `{ workItems }`
// and filtered `{ items, nextCursor }` work-item list responses can be
// produced/consumed behind one interface without changing the wire bodies.

import type {
  AttachmentDto,
  FieldSchemaDto,
  StageDto,
  WorkItemDto,
} from '@pc/contracts';
import type {
  Attachment,
  FieldSchema,
  Stage,
  WorkItem,
} from '@pc/domain';

/** Thrown when a row/DTO cannot be mapped because it is structurally invalid. */
export class WorkItemAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkItemAdapterError';
  }
}

export function toWorkItemDto(wi: WorkItem): WorkItemDto {
  if (!wi || typeof wi.id !== 'string') {
    throw new WorkItemAdapterError('invalid work item row: missing id');
  }
  return {
    id: wi.id,
    projectId: wi.projectId,
    parentId: wi.parentId,
    callsign: wi.callsign,
    position: wi.position,
    title: wi.title,
    body: wi.body,
    stageId: wi.stageId,
    status: wi.status,
    statusReason: wi.statusReason,
    type: wi.type,
    fields: wi.fields ?? {},
    version: wi.version,
    createdAt: wi.createdAt,
    updatedAt: wi.updatedAt,
    deletedAt: wi.deletedAt,
    isAgentTask: wi.isAgentTask,
    isWorkflowRoot: wi.isWorkflowRoot ?? false,
    ephemeral: wi.ephemeral,
    acceptanceCriteria: wi.acceptanceCriteria,
    expectedOutput: wi.expectedOutput,
    verificationTier: wi.verificationTier,
    verificationStatus: wi.verificationStatus,
    verificationNotes: wi.verificationNotes,
    assignedAgentRunId: wi.assignedAgentRunId,
    worktreePath: wi.worktreePath,
    areaId: wi.areaId ?? null,
  };
}

export function toStageDto(stage: Stage): StageDto {
  if (!stage || typeof stage.id !== 'string') {
    throw new WorkItemAdapterError('invalid stage: missing id');
  }
  const dto: StageDto = {
    id: stage.id,
    name: stage.name,
    position: stage.order,
  };
  if (stage.isNew !== undefined) dto.isNew = stage.isNew;
  if (stage.isDone !== undefined) dto.isDone = stage.isDone;
  if (stage.isCancelled !== undefined) dto.isCancelled = stage.isCancelled;
  if (stage.rev !== undefined) dto.rev = stage.rev;
  return dto;
}

export function toStageDtos(stages: Stage[], stagesRev?: number): StageDto[] {
  return stages.map((s) => {
    const dto = toStageDto(s);
    if (dto.rev === undefined && stagesRev !== undefined) dto.rev = stagesRev;
    return dto;
  });
}

export function toFieldSchemaDto(schema: FieldSchema): FieldSchemaDto {
  if (!schema || typeof schema.id !== 'string') {
    throw new WorkItemAdapterError('invalid field schema: missing id');
  }
  const dto: FieldSchemaDto = {
    id: schema.id,
    projectId: schema.projectId,
    key: schema.key,
    label: schema.label,
    type: schema.type,
    required: schema.required,
    order: schema.order,
  };
  if (schema.options !== undefined) dto.options = [...schema.options];
  if (schema.default !== undefined) dto.default = schema.default;
  if (schema.description !== undefined) dto.description = schema.description;
  return dto;
}

export function toAttachmentDto(att: Attachment): AttachmentDto {
  if (!att || typeof att.id !== 'string') {
    throw new WorkItemAdapterError('invalid attachment: missing id');
  }
  return {
    id: att.id,
    workItemId: att.workItemId,
    kind: att.kind,
    name: att.name,
    content: att.content,
    contentType: att.contentType,
    runId: att.runId,
    createdBySessionId: att.createdBySessionId,
    source: att.source,
    agentName: att.agentName,
    nodeId: att.nodeId,
    createdAt: att.createdAt,
  };
}

// ── List-shape normalizer ────────────────────────────────────────────────────

/** The two legacy work-item list response shapes. */
export type WorkItemListResponse =
  | { workItems: WorkItemDto[] }
  | { items: WorkItemDto[]; nextCursor: string | null };

/** Normalize either legacy list response into a single internal shape. Fails
 *  loud on a body matching neither shape. */
export function normalizeWorkItemListResponse(input: unknown): {
  items: WorkItemDto[];
  nextCursor: string | null;
} {
  if (!input || typeof input !== 'object') {
    throw new WorkItemAdapterError('work item list response must be an object');
  }
  const rec = input as Record<string, unknown>;
  if (Array.isArray(rec.items)) {
    return {
      items: rec.items as WorkItemDto[],
      nextCursor: typeof rec.nextCursor === 'string' ? rec.nextCursor : null,
    };
  }
  if (Array.isArray(rec.workItems)) {
    return { items: rec.workItems as WorkItemDto[], nextCursor: null };
  }
  throw new WorkItemAdapterError(
    'work item list response must carry { workItems } or { items, nextCursor }',
  );
}

/** Produce the no-filter legacy `{ workItems }` shape. */
export function toWorkItemsListBody(items: WorkItemDto[]): { workItems: WorkItemDto[] } {
  return { workItems: items };
}

/** Produce the filtered/paged legacy `{ items, nextCursor }` shape. */
export function toItemsCursorListBody(
  items: WorkItemDto[],
  nextCursor: string | null,
): { items: WorkItemDto[]; nextCursor: string | null } {
  return { items, nextCursor };
}
