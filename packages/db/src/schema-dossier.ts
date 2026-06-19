// pc-pty-chat-434 — Agent dossier table (Track B).
//
// One row per work item with three fixed text sections (state / decisions /
// open_questions). Agent-owned layer; humans are read-only in v1. The body
// column on work_items is the human brief (FD-5) and is never touched here.
//
// Kept in a separate file so the concern stays grep-able; re-exported from
// schema.ts so assertSchemaIntact() covers it on every boot.

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ULID } from '@pc/domain';

export const workItemDossiers = sqliteTable(
  'work_item_dossiers',
  {
    /** App-enforced FK to work_items.id — no DB constraint (mirrors area_id). */
    workItemId: text('work_item_id').primaryKey().notNull().$type<ULID>(),
    /** Running status: what is happening, what is done, where we left off. */
    state: text('state').notNull().default(''),
    /** Locked choices, rationale, architectural calls. Durable across runs. */
    decisions: text('decisions').notNull().default(''),
    /** Blockers, unknowns, next asks. Cleared when answered. */
    openQuestions: text('open_questions').notNull().default(''),
    /** ULID of the last agent_runs row that wrote. Null until first write. */
    updatedByRunId: text('updated_by_run_id').$type<ULID | null>(),
    /** Pod name of the last writer. Null until first write. */
    updatedByAgent: text('updated_by_agent'),
    /** Optimistic-concurrency counter — incremented on every write. */
    version: integer('version').notNull().default(0),
    /** Epoch ms set on first write. */
    createdAt: integer('created_at').notNull(),
    /** Epoch ms updated on every write. Staleness signal for A2/A3. */
    updatedAt: integer('updated_at').notNull(),
  },
);
