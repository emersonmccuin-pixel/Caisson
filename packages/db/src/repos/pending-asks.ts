// Section 25 — pending_asks repo.
//
// Atomic open→answered (or open→cancelled) flip via UPDATE WHERE status='open'.
// JSONL-replay re-delivery of an already-handled event cannot double-resume
// the child — the second update is a no-op (`changes === 0`).

import { and, asc, eq } from 'drizzle-orm';

import type {
  PendingAskKind,
  PendingAskOption,
  PendingAskRow,
  ULID,
} from '@pc/domain';

import { getDb } from '../connection.ts';
import { pendingAsks } from '../schema-agent-system.ts';

export interface CreatePendingAskInput {
  id: ULID;
  agentRunId: ULID;
  ccSessionId: string;
  projectId: ULID;
  parentWorkItemId?: ULID | null;
  kind: PendingAskKind;
  promptBody: string;
  context?: string | null;
  options?: PendingAskOption[] | null;
  now: number;
}

/** Write one open pending-ask row. Caller mints the ULID so the
 *  `agent-asks-*` event body can reference it before the row is fully
 *  persisted. */
export function createPendingAsk(input: CreatePendingAskInput): PendingAskRow {
  const row: PendingAskRow = {
    id: input.id,
    agentRunId: input.agentRunId,
    ccSessionId: input.ccSessionId,
    projectId: input.projectId,
    parentWorkItemId: input.parentWorkItemId ?? null,
    kind: input.kind,
    promptBody: input.promptBody,
    context: input.context ?? null,
    options: input.options ?? null,
    status: 'open',
    answerBody: null,
    answeredBy: null,
    createdAt: input.now,
    answeredAt: null,
    cancelledAt: null,
  };
  getDb().insert(pendingAsks).values(row).run();
  return row;
}

export function getPendingAsk(id: ULID): PendingAskRow | null {
  const row = getDb()
    .select()
    .from(pendingAsks)
    .where(eq(pendingAsks.id, id))
    .get();
  return row ?? null;
}

/** Open rows for a project, oldest first. Drives boot-time "you have N
 *  agents waiting on you" surfaces + Activity Panel scoping. */
export function listOpenPendingAsksForProject(projectId: ULID): PendingAskRow[] {
  return getDb()
    .select()
    .from(pendingAsks)
    .where(and(eq(pendingAsks.projectId, projectId), eq(pendingAsks.status, 'open')))
    .orderBy(asc(pendingAsks.createdAt))
    .all();
}

/** Open rows for a CC provider session, oldest first. Used by the runtime
 *  to detect a duplicate pause for the same session (would indicate a
 *  cross-stream bug). */
export function listOpenPendingAsksForSession(ccSessionId: string): PendingAskRow[] {
  return getDb()
    .select()
    .from(pendingAsks)
    .where(and(eq(pendingAsks.ccSessionId, ccSessionId), eq(pendingAsks.status, 'open')))
    .orderBy(asc(pendingAsks.createdAt))
    .all();
}

/** Fast boot/reconcile predicate for paused runs. */
export function hasOpenPendingAskForRun(agentRunId: ULID): boolean {
  const row = getDb()
    .select({ id: pendingAsks.id })
    .from(pendingAsks)
    .where(and(eq(pendingAsks.agentRunId, agentRunId), eq(pendingAsks.status, 'open')))
    .get();
  return row !== undefined;
}

/** Slice 014b — true iff this run EVER created a pending-ask (any status).
 *  Powers the `pending_ask_created` verification predicate: a contract whose
 *  acceptance requires "your first action MUST be pc_ask_orchestrator" is satisfied by
 *  a durable pending-ask row, even after it's been answered (status flips to
 *  `answered` on resume). Unlike `hasOpenPendingAskForRun` this does NOT filter
 *  on `status='open'`. */
export function hasPendingAskForRun(agentRunId: ULID): boolean {
  const row = getDb()
    .select({ id: pendingAsks.id })
    .from(pendingAsks)
    .where(eq(pendingAsks.agentRunId, agentRunId))
    .get();
  return row !== undefined;
}

export interface AnswerPendingAskInput {
  id: ULID;
  answer: string;
  answeredBy: 'orchestrator' | 'user';
  now: number;
}

/** Atomic `open → answered` transition. Returns `true` if THIS call flipped
 *  the row, `false` if it was already terminal. Caller surfaces the false
 *  case as `already-answered` / `cancelled` / `unknown-pending-ask` to its
 *  caller. */
export function markPendingAskAnswered(input: AnswerPendingAskInput): boolean {
  const res = getDb()
    .update(pendingAsks)
    .set({
      status: 'answered',
      answerBody: input.answer,
      answeredBy: input.answeredBy,
      answeredAt: input.now,
    })
    .where(and(eq(pendingAsks.id, input.id), eq(pendingAsks.status, 'open')))
    .run();
  return res.changes > 0;
}

/** Atomic `open → cancelled` transition. Used when the user cancels a
 *  paused agent from the Activity Panel or when the parent AgentRun is
 *  cancelled. */
export function markPendingAskCancelled(id: ULID, now: number): boolean {
  const res = getDb()
    .update(pendingAsks)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(and(eq(pendingAsks.id, id), eq(pendingAsks.status, 'open')))
    .run();
  return res.changes > 0;
}
