// pc-pty-chat-434 — agent dossier repo (Track B).
//
// One row per work item; partial-patch upsert with optimistic-concurrency guard.
// Provenance (updated_by_run_id, updated_by_agent) is stamped server-side from
// the caller's agent run context — never accepted from the JSON body.

import { eq } from 'drizzle-orm';
import type { ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import { agentRuns } from '../schema-agent-system.ts';
import { workItemDossiers } from '../schema-dossier.ts';

export interface DossierRow {
  workItemId: ULID;
  state: string;
  decisions: string;
  openQuestions: string;
  updatedByRunId: ULID | null;
  updatedByAgent: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertDossierInput {
  workItemId: ULID;
  /** Only supplied sections are updated; omit a key to leave it unchanged. */
  state?: string;
  decisions?: string;
  openQuestions?: string;
  /** ULID of the calling agent run (PC_AGENT_RUN_ID). Used to stamp provenance
   *  and look up the pod name. Null when called outside a run context. */
  agentRunId: ULID | null;
  /** If provided and the current row's version doesn't match, throws
   *  DossierVersionConflictError. Omit for blind writes (no conflict check). */
  expectedVersion?: number;
}

/** Thrown when an expected version doesn't match the current row version. */
export class DossierVersionConflictError extends Error {
  constructor(
    public readonly workItemId: ULID,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
    public readonly currentRow: DossierRow,
  ) {
    super(
      `dossier version conflict for ${workItemId}: expected ${expectedVersion}, got ${actualVersion}`,
    );
    this.name = 'DossierVersionConflictError';
  }
}

/** Read the current dossier row for a work item. Returns null when no row exists.
 *  Do NOT create a row on read — keep the table sparse (Risk 3). */
export function getDossier(workItemId: ULID): DossierRow | null {
  const row = getDb()
    .select()
    .from(workItemDossiers)
    .where(eq(workItemDossiers.workItemId, workItemId))
    .get();
  return row ? toDomain(row) : null;
}

/** Partial-patch upsert. Only the sections present in `input` are updated; the
 *  rest remain unchanged. Increments version on every successful write. Throws
 *  DossierVersionConflictError when an expected version is supplied and mismatches. */
export function upsertDossier(input: UpsertDossierInput): DossierRow {
  const db = getDb();
  const now = Date.now();

  // Look up pod name from the calling run (provenance, server-stamped).
  let agentName: string | null = null;
  if (input.agentRunId) {
    const run = db
      .select({ podName: agentRuns.podName })
      .from(agentRuns)
      .where(eq(agentRuns.id, input.agentRunId))
      .get();
    agentName = run?.podName ?? null;
  }

  const existing = db
    .select()
    .from(workItemDossiers)
    .where(eq(workItemDossiers.workItemId, input.workItemId))
    .get();

  if (existing) {
    // Optimistic-concurrency check: if the caller supplied an expected version,
    // verify it matches before writing. Do NOT silent last-write-win.
    if (
      input.expectedVersion !== undefined &&
      existing.version !== input.expectedVersion
    ) {
      throw new DossierVersionConflictError(
        input.workItemId,
        input.expectedVersion,
        existing.version,
        toDomain(existing),
      );
    }

    // Partial patch: only touch columns the caller supplied.
    const patch: Record<string, unknown> = {
      version: existing.version + 1,
      updatedByRunId: input.agentRunId,
      updatedByAgent: agentName,
      updatedAt: now,
    };
    if (input.state !== undefined) patch.state = input.state;
    if (input.decisions !== undefined) patch.decisions = input.decisions;
    if (input.openQuestions !== undefined) patch.openQuestions = input.openQuestions;

    db
      .update(workItemDossiers)
      .set(patch)
      .where(eq(workItemDossiers.workItemId, input.workItemId))
      .run();
  } else {
    // First write — INSERT.
    db.insert(workItemDossiers).values({
      workItemId: input.workItemId,
      state: input.state ?? '',
      decisions: input.decisions ?? '',
      openQuestions: input.openQuestions ?? '',
      updatedByRunId: input.agentRunId,
      updatedByAgent: agentName,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  const written = db
    .select()
    .from(workItemDossiers)
    .where(eq(workItemDossiers.workItemId, input.workItemId))
    .get();
  if (!written) throw new Error(`dossier upsert disappeared: ${input.workItemId}`);
  return toDomain(written);
}

function toDomain(row: typeof workItemDossiers.$inferSelect): DossierRow {
  return {
    workItemId: row.workItemId as ULID,
    state: row.state,
    decisions: row.decisions,
    openQuestions: row.openQuestions,
    updatedByRunId: (row.updatedByRunId as ULID | null) ?? null,
    updatedByAgent: row.updatedByAgent ?? null,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
