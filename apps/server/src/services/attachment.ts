// AttachmentService — project-scoped facade over the attachments repo.
//
// Asserts the target work item belongs to this project before exposing any
// CRUD path. The 2b spec only exposes list/get/delete to the UI; create is
// reserved for workflows (separate internal route, not wired in this phase).
// We still expose `create` here so the workflow-runtime + MCP tool can call
// through one consistent code path.

import type { Attachment, AttachmentSource, ULID, WorkItem } from '@pc/domain';
import type { AttachmentChangedLivePayload, AttachmentChangedReason } from '@pc/contracts';
import {
  createAttachment as dbCreateAttachment,
  deleteAttachment as dbDeleteAttachment,
  getAttachment as dbGetAttachment,
  getDb,
  insertLiveEvent,
  listAttachmentsForWorkItem,
} from '@pc/db';

// Slice 017 Fix 3 — durable live_outbox write for attachments (mirrors the
// work-item gateway pattern in work-item-writer.ts). Attachments have no
// version counter, so `version` is null. The relay drains the committed row
// post-commit and fans the canonical `attachment.changed` live-event frame.
// NEVER call broadcast inside the txn — just insertLiveEvent.
function announceAttachment(
  attachment: Attachment,
  projectId: ULID,
  reason: AttachmentChangedReason,
): void {
  const payload: AttachmentChangedLivePayload = {
    reason,
    workItemId: attachment.workItemId,
    // Domain Attachment matches the contract AttachmentDto field-for-field;
    // cast through unknown to bridge the nominal types (cf. work-item-writer).
    attachment: attachment as unknown as AttachmentChangedLivePayload['attachment'],
  };
  getDb().transaction((tx) => {
    insertLiveEvent(tx, {
      scope: 'project',
      projectId,
      type: 'attachment.changed',
      entity: 'attachment',
      entityId: attachment.id,
      version: null,
      payload,
    });
  });
}

export type AttachmentBroadcast = (event: {
  type: 'attachment-changed';
  change: 'created' | 'deleted';
  workItemId: ULID;
  attachment: Attachment;
}) => void;

export interface AttachmentServiceOptions {
  projectId: ULID;
  /** Read a work item by id — used to verify project ownership before any
   *  attachment CRUD. Returns null for unknown / archived rows. */
  getWorkItem: (id: ULID) => WorkItem | null;
  broadcast: AttachmentBroadcast;
}

export interface CreateAttachmentServiceInput {
  workItemId: ULID;
  kind: string;
  name: string;
  content: string;
  contentType?: string | null;
  runId?: ULID | null;
  createdBySessionId?: ULID | null;
  /** Provenance — who produced this attachment. Defaults to 'user'. The MCP
   *  `pc_attach_to_work_item` tool passes 'agent'. */
  source?: AttachmentSource;
  /** When `source === 'agent'`, the agent name. */
  agentName?: string | null;
  /** Workflow node id within `runId`. Null for non-workflow paths. */
  nodeId?: string | null;
}

/** Attachment not in this project's work-item tree. Maps to HTTP 404. */
export class AttachmentNotInProjectError extends Error {
  constructor(public readonly id: ULID) {
    super(`attachment ${id} not in this project`);
    this.name = 'AttachmentNotInProjectError';
  }
}

export class AttachmentService {
  constructor(private readonly opts: AttachmentServiceOptions) {}

  list(workItemId: ULID): Attachment[] {
    this.assertWorkItemInProject(workItemId);
    return listAttachmentsForWorkItem(workItemId);
  }

  get(id: ULID): Attachment {
    const attachment = dbGetAttachment(id);
    if (!attachment) throw new AttachmentNotInProjectError(id);
    this.assertWorkItemInProject(attachment.workItemId);
    return attachment;
  }

  delete(id: ULID): void {
    const attachment = dbGetAttachment(id);
    if (!attachment) throw new AttachmentNotInProjectError(id);
    this.assertWorkItemInProject(attachment.workItemId);
    dbDeleteAttachment(id);
    // Durable door (relay-delivered). Captured row passed pre-delete so the
    // payload carries the full attachment. KEEP the legacy bare broadcast
    // beside it during Phase A (reconcile-first); Phase C deletes the bare one.
    announceAttachment(attachment, this.opts.projectId, 'deleted');
    this.opts.broadcast({
      type: 'attachment-changed',
      change: 'deleted',
      workItemId: attachment.workItemId,
      attachment,
    });
  }

  create(input: CreateAttachmentServiceInput): Attachment {
    this.assertWorkItemInProject(input.workItemId);
    const attachment = dbCreateAttachment(input);
    // Durable door beside the legacy bare broadcast (Phase A reconcile-first).
    announceAttachment(attachment, this.opts.projectId, 'created');
    this.opts.broadcast({
      type: 'attachment-changed',
      change: 'created',
      workItemId: attachment.workItemId,
      attachment,
    });
    return attachment;
  }

  private assertWorkItemInProject(workItemId: ULID): void {
    const wi = this.opts.getWorkItem(workItemId);
    if (!wi || wi.projectId !== this.opts.projectId) {
      throw new AttachmentNotInProjectError(workItemId);
    }
  }
}
