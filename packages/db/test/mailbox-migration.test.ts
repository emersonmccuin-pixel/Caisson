// Fresh-DB migration safety (slice 007 — the FIRST real schema migration).
//
// Extends the live-outbox.test.ts runMigrations()-on-tmp pattern: a clean DB
// migrates cleanly, all six mailbox/interaction tables + every schema.ts column
// exist (assert via pragma table_info), assertSchemaIntact() does not throw, and
// the idempotency unique index is enforced. Guards the Drizzle "ledger lies →
// fresh-DB boot crash" trap (a recorded-but-not-applied migration).

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
  pending_interactions: [
    'id',
    'project_id',
    'kind',
    'status',
    'source_kind',
    'source_id',
    'source_ref',
    'prompt',
    'context',
    'options',
    'answer_body',
    'answered_by',
    'created_at',
    'updated_at',
    'answered_at',
    'cancelled_at',
    'expires_at',
    'version',
  ],
  mailbox_messages: [
    'id',
    'project_id',
    'kind',
    'subject',
    'body',
    'payload',
    'source_kind',
    'source_id',
    'interaction_id',
    'idempotency_key',
    'created_at',
    'updated_at',
    'expires_at',
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

test('0036 creates all six tables with every schema.ts column on a fresh DB', () => {
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
