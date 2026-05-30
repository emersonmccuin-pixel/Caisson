// Work-item mutation gateway (slice 003) — the single durable write door.
//
// Every durable work-item / stage / field-schema / attachment mutation flows
// through here so each has ONE validation/version/history/event point.
// Pattern (mirrors @pc/app-services ProjectService):
//   validate -> persist product mutation -> insert live_outbox row
//   in the SAME getDb().transaction -> return a publication the server
//   composition layer fans out (canonical {type:'live-event',event} + legacy
//   websocket name) AFTER commit. A rollback emits nothing.
//
// Boundary purity: imports only @pc/contracts, @pc/db, @pc/domain. No Hono,
// React, websocket hub, Channel, MCP SDK, or runtime process classes.

import type {
  AttachmentChangedLivePayload,
  AttachmentChangedRefetchEnvelope,
  AttachmentDto,
  FieldSchemaListChangedLivePayload,
  FieldSchemasChangedRefetchEnvelope,
  StageListChangedLivePayload,
  StagesChangedRefetchEnvelope,
  ULID,
  WorkItemChangedLivePayload,
  WorkItemChangedRefetchEnvelope,
  WorkItemDto,
  WorkItemMutationReason,
} from '@pc/contracts';
import { buildAttachmentChangedRefetchEnvelope } from '@pc/contracts';
import { buildFieldSchemasChangedRefetchEnvelope } from '@pc/contracts';
import { buildStagesChangedRefetchEnvelope } from '@pc/contracts';
import { buildWorkItemChangedRefetchEnvelope } from '@pc/contracts';
import {
  getDb,
  getWorkItem as dbGetWorkItem,
  insertLiveEvent,
  type DbExecutor,
  type InsertLiveEventDraft,
  type LiveOutboxEvent,
} from '@pc/db';
import type { FieldSchema, Stage, ULID as DomainULID, WorkItem } from '@pc/domain';
import {
  toAttachmentDto,
  toFieldSchemaDto,
  toStageDtos,
  toWorkItemDto,
  type WorkItemListResponse,
} from './adapters.ts';

export type { WorkItemListResponse };

// ── Canonical live-event shapes (reuse the slice-002 LiveOutboxEvent) ─────────

export interface WorkItemChangedPublication {
  liveEvent: LiveOutboxEvent<WorkItemChangedLivePayload>;
  legacyEvent: WorkItemChangedRefetchEnvelope | null;
}

export interface StageListChangedPublication {
  liveEvent: LiveOutboxEvent<StageListChangedLivePayload>;
  legacyEvent: StagesChangedRefetchEnvelope;
}

export interface FieldSchemaListChangedPublication {
  liveEvent: LiveOutboxEvent<FieldSchemaListChangedLivePayload>;
  legacyEvent: FieldSchemasChangedRefetchEnvelope;
}

export interface AttachmentChangedPublication {
  liveEvent: LiveOutboxEvent<AttachmentChangedLivePayload>;
  legacyEvent: AttachmentChangedRefetchEnvelope;
}

// ── Draft builders ────────────────────────────────────────────────────────────

export function buildWorkItemChangedDraft(input: {
  projectId: ULID;
  workItem: WorkItemDto;
  reason: WorkItemMutationReason;
  attachments?: AttachmentDto[];
}): InsertLiveEventDraft<WorkItemChangedLivePayload> {
  const payload: WorkItemChangedLivePayload = {
    reason: input.reason,
    workItem: input.workItem,
  };
  if (input.attachments) payload.attachments = input.attachments;
  return {
    scope: 'project',
    projectId: input.projectId as DomainULID,
    type: 'work-item.changed',
    entity: 'work-item',
    entityId: input.workItem.id as DomainULID,
    version: input.workItem.version,
    payload,
  };
}

export function buildStageListChangedDraft(input: {
  projectId: ULID;
  stagesRev: number;
  stages: ReturnType<typeof toStageDtos>;
}): InsertLiveEventDraft<StageListChangedLivePayload> {
  return {
    scope: 'project',
    projectId: input.projectId as DomainULID,
    type: 'stage.list.changed',
    entity: 'stage',
    entityId: null,
    version: input.stagesRev,
    payload: { stagesRev: input.stagesRev, stages: input.stages, reason: 'replaced' },
  };
}

export function buildFieldSchemaListChangedDraft(input: {
  projectId: ULID;
  schemas: ReturnType<typeof toFieldSchemaDto>[];
}): InsertLiveEventDraft<FieldSchemaListChangedLivePayload> {
  return {
    scope: 'project',
    projectId: input.projectId as DomainULID,
    type: 'field-schema.list.changed',
    entity: 'field-schema',
    entityId: null,
    version: null,
    payload: { schemas: input.schemas, reason: 'replaced' },
  };
}

export function buildAttachmentChangedDraft(input: {
  projectId: ULID;
  workItemId: ULID;
  attachmentId: ULID;
  reason: 'created' | 'deleted';
  attachment?: AttachmentDto;
}): InsertLiveEventDraft<AttachmentChangedLivePayload> {
  const payload: AttachmentChangedLivePayload = {
    reason: input.reason,
    workItemId: input.workItemId,
  };
  if (input.attachment) payload.attachment = input.attachment;
  return {
    scope: 'project',
    projectId: input.projectId as DomainULID,
    type: 'attachment.changed',
    entity: 'attachment',
    entityId: input.attachmentId as DomainULID,
    version: null,
    payload,
  };
}

// ── Gateway ──────────────────────────────────────────────────────────────────

export interface WorkItemGatewayDeps {
  /** Single transaction door. Defaults to the live DB; tests inject a fake. */
  transaction?: <T>(fn: (tx: DbExecutor) => T) => T;
  /** Insert a live-outbox row inside the transaction. Defaults to @pc/db. */
  insertLiveEvent?: typeof insertLiveEvent;
}

/**
 * The mutation gateway. Each method runs a caller-supplied product mutation
 * (already validated by the caller's domain layer) and atomically records the
 * matching live-outbox row, returning the publication. Callers fan out the
 * canonical + legacy events AFTER the transaction commits.
 */
export class WorkItemMutationGateway {
  private readonly tx: <T>(fn: (tx: DbExecutor) => T) => T;
  private readonly insert: typeof insertLiveEvent;

  constructor(deps: WorkItemGatewayDeps = {}) {
    this.tx = deps.transaction ?? ((fn) => getDb().transaction(fn));
    this.insert = deps.insertLiveEvent ?? insertLiveEvent;
  }

  /** Persist a work-item mutation + record its canonical fact atomically.
   *  `mutate` returns the changed WorkItem (or null when the row vanished). */
  commitWorkItemChange(input: {
    projectId: ULID;
    reason: WorkItemMutationReason;
    mutate: (tx: DbExecutor) => WorkItem | null;
    attachments?: AttachmentDto[];
  }): { workItem: WorkItemDto } & WorkItemChangedPublication {
    return this.tx((tx) => {
      const row = input.mutate(tx);
      if (!row) throw new Error('work item mutation produced no row');
      const dto = toWorkItemDto(row);
      const liveEvent = this.insert(
        tx,
        buildWorkItemChangedDraft({
          projectId: input.projectId,
          workItem: dto,
          reason: input.reason,
          ...(input.attachments ? { attachments: input.attachments } : {}),
        }),
      );
      const legacyEvent = buildWorkItemChangedRefetchEnvelope({
        projectId: input.projectId,
        workItem: dto,
      });
      return { workItem: dto, liveEvent, legacyEvent };
    });
  }

  /** Record a work-item fact when the product mutation already happened
   *  outside this gateway transaction (used while routing the legacy
   *  verification / auto-advance / DAG paths through the gateway without
   *  re-doing their writes). Inserts the outbox row in its own transaction. */
  announceWorkItemChange(input: {
    projectId: ULID;
    reason: WorkItemMutationReason;
    workItem: WorkItem;
    attachments?: AttachmentDto[];
  }): { workItem: WorkItemDto } & WorkItemChangedPublication {
    return this.commitWorkItemChange({
      projectId: input.projectId,
      reason: input.reason,
      mutate: () => input.workItem,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
  }

  /** Re-read a work item by id and announce it. Convenience for call sites
   *  that mutated via a repo helper and hold only the id. */
  announceWorkItemById(input: {
    projectId: ULID;
    reason: WorkItemMutationReason;
    workItemId: ULID;
  }): ({ workItem: WorkItemDto } & WorkItemChangedPublication) | null {
    const wi = dbGetWorkItem(input.workItemId as DomainULID);
    if (!wi) return null;
    return this.announceWorkItemChange({
      projectId: input.projectId,
      reason: input.reason,
      workItem: wi,
    });
  }

  commitStageListChange(input: {
    projectId: ULID;
    mutate: (tx: DbExecutor) => { stagesRev: number; stages: Stage[] };
  }): { stagesRev: number; stages: ReturnType<typeof toStageDtos> } & StageListChangedPublication {
    return this.tx((tx) => {
      const { stagesRev, stages } = input.mutate(tx);
      const stageDtos = toStageDtos(stages, stagesRev);
      const liveEvent = this.insert(
        tx,
        buildStageListChangedDraft({ projectId: input.projectId, stagesRev, stages: stageDtos }),
      );
      const legacyEvent = buildStagesChangedRefetchEnvelope({
        projectId: input.projectId,
        stagesRev,
        stages: stageDtos,
      });
      return { stagesRev, stages: stageDtos, liveEvent, legacyEvent };
    });
  }

  commitFieldSchemaListChange(input: {
    projectId: ULID;
    mutate: (tx: DbExecutor) => FieldSchema[];
  }): { schemas: ReturnType<typeof toFieldSchemaDto>[] } & FieldSchemaListChangedPublication {
    return this.tx((tx) => {
      const schemas = input.mutate(tx).map(toFieldSchemaDto);
      const liveEvent = this.insert(
        tx,
        buildFieldSchemaListChangedDraft({ projectId: input.projectId, schemas }),
      );
      const legacyEvent = buildFieldSchemasChangedRefetchEnvelope({
        projectId: input.projectId,
        schemas,
      });
      return { schemas, liveEvent, legacyEvent };
    });
  }

  commitAttachmentChange(input: {
    projectId: ULID;
    workItemId: ULID;
    reason: 'created' | 'deleted';
    mutate: (tx: DbExecutor) => { attachmentId: ULID; attachment?: AttachmentDto };
  }): { attachmentId: ULID; attachment?: AttachmentDto } & AttachmentChangedPublication {
    return this.tx((tx) => {
      const { attachmentId, attachment } = input.mutate(tx);
      const liveEvent = this.insert(
        tx,
        buildAttachmentChangedDraft({
          projectId: input.projectId,
          workItemId: input.workItemId,
          attachmentId,
          reason: input.reason,
          ...(attachment ? { attachment } : {}),
        }),
      );
      const legacyEvent = buildAttachmentChangedRefetchEnvelope({
        projectId: input.projectId,
        workItemId: input.workItemId,
        reason: input.reason,
        attachmentId,
      });
      return { attachmentId, ...(attachment ? { attachment } : {}), liveEvent, legacyEvent };
    });
  }
}

export { toAttachmentDto };
