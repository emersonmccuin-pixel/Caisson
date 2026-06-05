// Fresh-DB migration safety (slice 007 — the FIRST real schema migration).
//
// Extends the live-outbox.test.ts runMigrations()-on-tmp pattern: a clean DB
// migrates cleanly, every mailbox table + every schema.ts column exists
// (assert via pragma table_info), assertSchemaIntact() does not throw, and
// the idempotency unique index is enforced. Guards the Drizzle "ledger lies →
// fresh-DB boot crash" trap (a recorded-but-not-applied migration).
// M8/FD-7 (migration 0045): pending_interactions is archive-renamed and
// mailbox_messages.interaction_id dropped — asserted below.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-mailbox-migration-'));
process.env.PC_DATA_DIR = tmpDir;

const { assertSchemaIntact, closeDb, getRawDb, runMigrations } = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const EXPECTED_COLUMNS: Record<string, string[]> = {
  mailbox_messages: [
    'id',
    'project_id',
    'kind',
    'subject',
    'body',
    'payload',
    'source_kind',
    'source_id',
    'idempotency_key',
    'created_at',
    'updated_at',
  ],
  mailbox_recipients: [
    'id',
    'message_id',
    'address_kind',
    'address_json',
    'read_at',
    'actioned_at',
    'dismissed_at',
    'created_at',
  ],
  mailbox_deliveries: [
    'id',
    'message_id',
    'recipient_id',
    'channel',
    'status',
    'lease_owner',
    'lease_expires_at',
    'attempts',
    'next_attempt_at',
    'target_ref_kind',
    'target_ref_id',
    'last_error',
    'created_at',
    'updated_at',
    'accepted_at',
    'failed_at',
  ],
  mailbox_dead_letters: ['id', 'message_id', 'recipient_id', 'delivery_id', 'reason', 'last_error', 'created_at'],
  mailbox_audit: [
    'id',
    'message_id',
    'recipient_id',
    'delivery_id',
    'action',
    'actor_kind',
    'actor_id',
    'details',
    'created_at',
  ],
};

test('migrations create every mailbox table with every schema.ts column on a fresh DB', () => {
  const raw = getRawDb();
  for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
    const info = raw.pragma(`table_info("${table}")`) as { name: string }[];
    assert.ok(info.length > 0, `table ${table} should exist`);
    const actual = new Set(info.map((c) => c.name));
    for (const column of columns) {
      assert.ok(actual.has(column), `${table}.${column} should exist`);
    }
  }
});

test('M8/FD-7 (0045): pending_interactions archived; interaction_id dropped', () => {
  const raw = getRawDb();
  const live = raw.pragma(`table_info("pending_interactions")`) as { name: string }[];
  assert.equal(live.length, 0, 'pending_interactions must not exist live');
  const archived = raw.pragma(`table_info("pending_interactions_v2_archive")`) as { name: string }[];
  assert.ok(archived.length > 0, 'archive table should exist (rename, not drop)');
  const msgCols = new Set(
    (raw.pragma(`table_info("mailbox_messages")`) as { name: string }[]).map((c) => c.name),
  );
  assert.ok(!msgCols.has('interaction_id'), 'mailbox_messages.interaction_id must be dropped');
});

test('M4b/FD-8 (0046): mailbox_messages.expires_at stays deleted', () => {
  const raw = getRawDb();
  const msgCols = new Set(
    (raw.pragma(`table_info("mailbox_messages")`) as { name: string }[]).map((c) => c.name),
  );
  assert.ok(!msgCols.has('expires_at'), 'mailbox_messages.expires_at must be dropped (dead knob)');
});

test('assertSchemaIntact does not throw after a fresh migrate', () => {
  assert.doesNotThrow(() => assertSchemaIntact());
});

test('mailbox_messages.idempotency_key unique index is enforced', () => {
  const raw = getRawDb();
  const insert = (id: string, key: string) =>
    raw
      .prepare(
        `INSERT INTO mailbox_messages (id, project_id, kind, body, payload, source_kind, idempotency_key, created_at, updated_at) ` +
          `VALUES (?, NULL, 'system-notice', 'hi', '{}', 'system', ?, 1, 1)`,
      )
      .run(id, key);
  insert('m-dup-1', 'dup-key');
  assert.throws(() => insert('m-dup-2', 'dup-key'), /UNIQUE/);
});
