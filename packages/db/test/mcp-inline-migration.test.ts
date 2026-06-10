// pc-pty-chat-359 P4b — migration 0055 test.
//
// Uses an in-memory SQLite database to isolate the migration SQL from the full
// chain. Sets up the before state (tables as of migration 0054), inserts test
// data, runs migration 0055, and asserts the correct after state.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_SQL = readFileSync(
  join(__dirname, '..', 'drizzle', '0055_migrate_inline_mcp_to_registry.sql'),
  'utf8',
);

const MIGRATION_STATEMENTS = MIGRATION_SQL
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);

function createPreMigrationDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(
    "CREATE TABLE agents (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL DEFAULT '');" +
    "CREATE TABLE mcp_servers (" +
    "  id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, project_id TEXT," +
    "  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT ''," +
    "  transport TEXT NOT NULL, discovered_tools TEXT," +
    "  discovery_status TEXT NOT NULL DEFAULT 'stale', rev INTEGER NOT NULL DEFAULT 0," +
    "  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER" +
    ");" +
    "CREATE UNIQUE INDEX mcp_servers_global_name_idx ON mcp_servers (name)" +
    "  WHERE scope = 'global' AND deleted_at IS NULL;" +
    "CREATE UNIQUE INDEX mcp_servers_project_name_idx ON mcp_servers (project_id, name)" +
    "  WHERE scope = 'project' AND deleted_at IS NULL;" +
    "CREATE TABLE agent_mcp_attachments (" +
    "  id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL, mcp_server_id TEXT NOT NULL," +
    "  enabled_tools TEXT NOT NULL DEFAULT '*', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL" +
    ");" +
    "CREATE UNIQUE INDEX agent_mcp_attachments_unique_idx" +
    "  ON agent_mcp_attachments (agent_id, mcp_server_id);" +
    "CREATE TABLE agent_mcp_servers (" +
    "  id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL, scope TEXT NOT NULL," +
    "  project_id TEXT, name TEXT NOT NULL, config_json TEXT NOT NULL, created_at INTEGER NOT NULL" +
    ");",
  );
  return db;
}

function applyMigration(db: Database.Database): void {
  for (const sql of MIGRATION_STATEMENTS) {
    db.exec(sql);
  }
}

after(() => { /* :memory: DBs need no cleanup */ });

test('single inline row migrates to one registry entry + one attachment', () => {
  const db = createPreMigrationDb();
  db.exec("INSERT INTO agents VALUES ('agent-1', 'test')");
  db.exec(
    "INSERT INTO agent_mcp_servers VALUES" +
    " ('ams-1', 'agent-1', 'global', NULL, 'my-server', '{\"command\":\"node\"}', 1000)",
  );
  applyMigration(db);

  const reg = db.prepare('SELECT * FROM mcp_servers').all() as Array<{
    id: string; name: string; transport: string; scope: string;
  }>;
  assert.equal(reg.length, 1);
  assert.equal(reg[0].id, 'ams-1');
  assert.equal(reg[0].name, 'my-server');
  assert.equal(reg[0].scope, 'global');
  assert.deepEqual(JSON.parse(reg[0].transport), { command: 'node' });

  const att = db.prepare('SELECT * FROM agent_mcp_attachments').all() as Array<{
    id: string; agent_id: string; mcp_server_id: string; enabled_tools: string;
  }>;
  assert.equal(att.length, 1);
  assert.equal(att[0].agent_id, 'agent-1');
  assert.equal(att[0].mcp_server_id, 'ams-1');
  assert.equal(att[0].enabled_tools, '*');

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_mcp_servers'",
  ).all() as Array<{ name: string }>;
  assert.equal(tables.length, 0, 'agent_mcp_servers table is dropped');

  db.close();
});

test('two agents share same server name: one registry entry + two attachments', () => {
  const db = createPreMigrationDb();
  db.exec("INSERT INTO agents VALUES ('agent-1', 'a1'), ('agent-2', 'a2')");
  db.exec(
    "INSERT INTO agent_mcp_servers VALUES" +
    " ('ams-1', 'agent-1', 'global', NULL, 'shared', '{\"command\":\"n\"}', 1000)," +
    " ('ams-2', 'agent-2', 'global', NULL, 'shared', '{\"command\":\"n\"}', 1001)",
  );
  applyMigration(db);

  const reg = db.prepare('SELECT * FROM mcp_servers').all() as Array<{ id: string }>;
  assert.equal(reg.length, 1, 'deduped to one registry entry');
  assert.equal(reg[0].id, 'ams-1', 'canonical id is MIN(id)');

  const att = db.prepare('SELECT * FROM agent_mcp_attachments ORDER BY id').all() as Array<{
    mcp_server_id: string;
  }>;
  assert.equal(att.length, 2);
  assert.equal(att[0].mcp_server_id, 'ams-1');
  assert.equal(att[1].mcp_server_id, 'ams-1');

  db.close();
});

test('empty agent_mcp_servers: migration produces no rows', () => {
  const db = createPreMigrationDb();
  applyMigration(db);
  assert.equal((db.prepare('SELECT * FROM mcp_servers').all() as unknown[]).length, 0);
  assert.equal((db.prepare('SELECT * FROM agent_mcp_attachments').all() as unknown[]).length, 0);
  db.close();
});
