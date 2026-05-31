import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { newId } from '../id.ts';
import { orchestratorSendQueue } from '../schema.ts';

export type OrchestratorSendQueueStatus =
  | 'queued_busy'
  | 'queued_spawning'
  | 'queued_backlog'
  | 'delivering'
  | 'delivered_to_pty'
  | 'observed_in_jsonl'
  | 'failed'
  | 'cancelled';

export interface OrchestratorSendQueueRow {
  id: ULID;
  projectId: ULID;
  sessionId: ULID;
  clientMessageId: string;
  text: string;
  status: OrchestratorSendQueueStatus;
  deliveryAttempts: number;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  failedAt: number | null;
  cancelledAt: number | null;
  failureReason: string | null;
}

interface QueueRow {
  id: ULID;
  projectId: ULID;
  sessionId: ULID;
  clientMessageId: string;
  text: string;
  status: OrchestratorSendQueueStatus;
  deliveryAttempts: number;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  failedAt: number | null;
  cancelledAt: number | null;
  failureReason: string | null;
}

const OPEN_STATUSES: OrchestratorSendQueueStatus[] = [
  'queued_busy',
  'queued_spawning',
  'queued_backlog',
  'delivering',
  'delivered_to_pty',
];

const QUEUED_STATUSES: OrchestratorSendQueueStatus[] = [
  'queued_busy',
  'queued_spawning',
  'queued_backlog',
];

const VISIBLE_STATUSES: OrchestratorSendQueueStatus[] = [
  ...OPEN_STATUSES,
  'failed',
];

function toDomain(row: QueueRow): OrchestratorSendQueueRow {
  return { ...row };
}

export interface EnqueueOrchestratorSendInput {
  projectId: ULID;
  sessionId: ULID;
  clientMessageId: string;
  text: string;
  status: Extract<
    OrchestratorSendQueueStatus,
    'queued_busy' | 'queued_spawning' | 'queued_backlog'
  >;
}

export function enqueueOrchestratorSend(
  input: EnqueueOrchestratorSendInput,
): OrchestratorSendQueueRow {
  const now = Date.now();
  const row: QueueRow = {
    id: newId(),
    projectId: input.projectId,
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
    text: input.text,
    status: input.status,
    deliveryAttempts: 0,
    createdAt: now,
    updatedAt: now,
    deliveredAt: null,
    failedAt: null,
    cancelledAt: null,
    failureReason: null,
  };
  getDb().insert(orchestratorSendQueue).values(row).run();
  return toDomain(row);
}

export interface RecordDeliveredOrchestratorSendInput {
  projectId: ULID;
  sessionId: ULID;
  clientMessageId: string;
  text: string;
}

export function recordDeliveredOrchestratorSend(
  input: RecordDeliveredOrchestratorSendInput,
): OrchestratorSendQueueRow {
  const now = Date.now();
  const row: QueueRow = {
    id: newId(),
    projectId: input.projectId,
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
    text: input.text,
    status: 'delivered_to_pty',
    deliveryAttempts: 1,
    createdAt: now,
    updatedAt: now,
    deliveredAt: now,
    failedAt: null,
    cancelledAt: null,
    failureReason: null,
  };
  getDb().insert(orchestratorSendQueue).values(row).run();
  return toDomain(row);
}

export function listOpenOrchestratorSendsForSession(
  sessionId: ULID,
): OrchestratorSendQueueRow[] {
  const rows = getDb()
    .select()
    .from(orchestratorSendQueue)
    .where(
      and(
        eq(orchestratorSendQueue.sessionId, sessionId),
        inArray(orchestratorSendQueue.status, OPEN_STATUSES),
      ),
    )
    // Stable FIFO: created_at can tie under rapid sends (same ms); the monotonic
    // ULID id is the insertion-order tiebreaker so ordering is deterministic.
    .orderBy(asc(orchestratorSendQueue.createdAt), asc(orchestratorSendQueue.id))
    .all() as QueueRow[];
  return rows.map(toDomain);
}

export function getOrchestratorSendQueueRow(
  id: ULID,
): OrchestratorSendQueueRow | undefined {
  const row = getDb()
    .select()
    .from(orchestratorSendQueue)
    .where(eq(orchestratorSendQueue.id, id))
    .get() as QueueRow | undefined;
  return row ? toDomain(row) : undefined;
}

/** Look up a send row by its `(sessionId, clientMessageId)` idempotency key
 *  (the existing unique index). Used by the slice-006 `enqueueRuntimeTurn`
 *  facade so a mailbox/system replay returns the existing row instead of
 *  double-enqueuing. */
export function getOrchestratorSendByClientMessageId(
  sessionId: ULID,
  clientMessageId: string,
): OrchestratorSendQueueRow | undefined {
  const row = getDb()
    .select()
    .from(orchestratorSendQueue)
    .where(
      and(
        eq(orchestratorSendQueue.sessionId, sessionId),
        eq(orchestratorSendQueue.clientMessageId, clientMessageId),
      ),
    )
    .get() as QueueRow | undefined;
  return row ? toDomain(row) : undefined;
}

export function listVisibleOrchestratorSendsForSession(
  sessionId: ULID,
): OrchestratorSendQueueRow[] {
  const rows = getDb()
    .select()
    .from(orchestratorSendQueue)
    .where(
      and(
        eq(orchestratorSendQueue.sessionId, sessionId),
        inArray(orchestratorSendQueue.status, VISIBLE_STATUSES),
      ),
    )
    // Stable FIFO: created_at can tie under rapid sends (same ms); the monotonic
    // ULID id is the insertion-order tiebreaker so ordering is deterministic.
    .orderBy(asc(orchestratorSendQueue.createdAt), asc(orchestratorSendQueue.id))
    .all() as QueueRow[];
  return rows.map(toDomain);
}

export function listQueuedOrchestratorSendsForSession(
  sessionId: ULID,
): OrchestratorSendQueueRow[] {
  const rows = getDb()
    .select()
    .from(orchestratorSendQueue)
    .where(
      and(
        eq(orchestratorSendQueue.sessionId, sessionId),
        inArray(orchestratorSendQueue.status, QUEUED_STATUSES),
      ),
    )
    // Stable FIFO: created_at can tie under rapid sends (same ms); the monotonic
    // ULID id is the insertion-order tiebreaker so ordering is deterministic.
    .orderBy(asc(orchestratorSendQueue.createdAt), asc(orchestratorSendQueue.id))
    .all() as QueueRow[];
  return rows.map(toDomain);
}

export function hasOpenOrchestratorSendsForSession(sessionId: ULID): boolean {
  return listOpenOrchestratorSendsForSession(sessionId).length > 0;
}

export function markOrchestratorSendDelivering(id: ULID): void {
  const now = Date.now();
  const row = getDb()
    .select()
    .from(orchestratorSendQueue)
    .where(eq(orchestratorSendQueue.id, id))
    .get() as QueueRow | undefined;
  getDb()
    .update(orchestratorSendQueue)
    .set({
      status: 'delivering',
      deliveryAttempts: (row?.deliveryAttempts ?? 0) + 1,
      updatedAt: now,
      failureReason: null,
    })
    .where(eq(orchestratorSendQueue.id, id))
    .run();
}

export function markOrchestratorSendDelivered(id: ULID): void {
  const now = Date.now();
  getDb()
    .update(orchestratorSendQueue)
    .set({
      status: 'delivered_to_pty',
      updatedAt: now,
      deliveredAt: now,
      failureReason: null,
    })
    .where(eq(orchestratorSendQueue.id, id))
    .run();
}

export function markNextDeliveredOrchestratorSendObservedInJsonl(
  sessionId: ULID,
  text: string,
): OrchestratorSendQueueRow | undefined {
  const row = getDb()
    .select()
    .from(orchestratorSendQueue)
    .where(
      and(
        eq(orchestratorSendQueue.sessionId, sessionId),
        eq(orchestratorSendQueue.status, 'delivered_to_pty'),
        eq(orchestratorSendQueue.text, text),
      ),
    )
    .orderBy(asc(orchestratorSendQueue.createdAt))
    .get() as QueueRow | undefined;
  if (!row) return undefined;

  const now = Date.now();
  getDb()
    .update(orchestratorSendQueue)
    .set({
      status: 'observed_in_jsonl',
      updatedAt: now,
      failureReason: null,
    })
    .where(
      and(
        eq(orchestratorSendQueue.id, row.id),
        eq(orchestratorSendQueue.status, 'delivered_to_pty'),
      ),
    )
    .run();
  return getOrchestratorSendQueueRow(row.id);
}

export function markOrchestratorSendFailed(id: ULID, reason: string): void {
  const now = Date.now();
  getDb()
    .update(orchestratorSendQueue)
    .set({
      status: 'failed',
      updatedAt: now,
      failedAt: now,
      failureReason: reason,
    })
    .where(eq(orchestratorSendQueue.id, id))
    .run();
}

export function cancelQueuedOrchestratorSend(
  id: ULID,
  sessionId: ULID,
  reason: string,
): OrchestratorSendQueueRow | undefined {
  const row = getOrchestratorSendQueueRow(id);
  if (!row || row.sessionId !== sessionId || !QUEUED_STATUSES.includes(row.status)) {
    return undefined;
  }
  const now = Date.now();
  getDb()
    .update(orchestratorSendQueue)
    .set({
      status: 'cancelled',
      updatedAt: now,
      cancelledAt: now,
      failureReason: reason,
    })
    .where(
      and(
        eq(orchestratorSendQueue.id, id),
        eq(orchestratorSendQueue.sessionId, sessionId),
        inArray(orchestratorSendQueue.status, QUEUED_STATUSES),
      ),
    )
    .run();
  return getOrchestratorSendQueueRow(id);
}

export function retryFailedOrchestratorSend(
  id: ULID,
  sessionId: ULID,
  status: Extract<
    OrchestratorSendQueueStatus,
    'queued_busy' | 'queued_spawning' | 'queued_backlog'
  >,
): OrchestratorSendQueueRow | undefined {
  const row = getOrchestratorSendQueueRow(id);
  if (!row || row.sessionId !== sessionId || row.status !== 'failed') {
    return undefined;
  }
  const now = Date.now();
  getDb()
    .update(orchestratorSendQueue)
    .set({
      status,
      updatedAt: now,
      deliveredAt: null,
      failedAt: null,
      failureReason: null,
    })
    .where(
      and(
        eq(orchestratorSendQueue.id, id),
        eq(orchestratorSendQueue.sessionId, sessionId),
        eq(orchestratorSendQueue.status, 'failed'),
      ),
    )
    .run();
  return getOrchestratorSendQueueRow(id);
}

export function cancelOpenOrchestratorSendsForSession(
  sessionId: ULID,
  reason: string,
): void {
  const now = Date.now();
  getDb()
    .update(orchestratorSendQueue)
    .set({
      status: 'cancelled',
      updatedAt: now,
      cancelledAt: now,
      failureReason: reason,
    })
    .where(
      and(
        eq(orchestratorSendQueue.sessionId, sessionId),
        inArray(orchestratorSendQueue.status, OPEN_STATUSES),
      ),
    )
    .run();
}
