// M3b — boot backfill: per-session replay files import into
// conversation_events once, rename `*.imported`, and never double-import.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-conversation-backfill-'));
process.env.PC_DATA_DIR = tmpDir;

const { appendConversationEvent, closeDb, listConversationEvents, runMigrations } =
  await import('@pc/db');
const { backfillConversationEvents } = await import('../src/services/conversation-backfill.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const quiet = { log: () => {}, warn: () => {} };

function sessionDir(projectId: string, sessionId: string): string {
  const dir = join(tmpDir, 'projects', projectId, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeNormalizedLog(dir: string, sessionId: string): void {
  const rows = [
    { type: 'jsonl', id: `${sessionId}:1`, sessionId, seq: 1, kind: 'jsonl-user', event: { kind: 'jsonl-user', text: 'one' }, source: { kind: 'claude-jsonl', cursor: 11 } },
    'not json at all',
    { type: 'jsonl', id: `${sessionId}:2`, sessionId, seq: 2, kind: 'jsonl-turn-end', event: { kind: 'jsonl-turn-end', text: 'two' }, source: { kind: 'claude-jsonl', cursor: 12 } },
  ];
  writeFileSync(
    join(dir, 'jsonl-events.jsonl'),
    rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'),
    'utf-8',
  );
}

test('imports a normalized log (skipping malformed lines) and renames it *.imported', () => {
  const dir = sessionDir('proj-a', 'sess-a');
  writeNormalizedLog(dir, 'sess-a');

  const result = backfillConversationEvents(tmpDir, { logger: quiet });
  assert.equal(result.sessionsImported, 1);
  assert.equal(result.eventsImported, 2);
  assert.equal(result.filesRenamed, 1);
  assert.ok(!existsSync(join(dir, 'jsonl-events.jsonl')), 'original renamed away');
  assert.ok(existsSync(join(dir, 'jsonl-events.jsonl.imported')), 'forensics copy kept');

  const rows = listConversationEvents('sess-a');
  assert.deepEqual(rows.map((r) => r.seq), [1, 2]);
  assert.equal(rows[0]!.kind, 'jsonl-user');
  assert.equal(rows[0]!.sourceCursor, 11);
  assert.deepEqual(rows[1]!.event, { kind: 'jsonl-turn-end', text: 'two' });
});

test('a second sweep is a no-op (file already renamed)', () => {
  const result = backfillConversationEvents(tmpDir, { logger: quiet });
  assert.deepEqual(result, { sessionsImported: 0, eventsImported: 0, filesRenamed: 0 });
  assert.equal(listConversationEvents('sess-a').length, 2);
});

test('a session that ALREADY has rows renames without importing (crash-idempotent)', () => {
  appendConversationEvent({
    sessionId: 'sess-b',
    seq: 1,
    type: 'jsonl',
    kind: 'jsonl-user',
    event: { kind: 'jsonl-user', text: 'pre-existing' },
    sourceKind: 'claude-jsonl',
    sourceCursor: 1,
    now: 1,
  });
  const dir = sessionDir('proj-a', 'sess-b');
  writeNormalizedLog(dir, 'sess-b');

  const result = backfillConversationEvents(tmpDir, { logger: quiet });
  assert.equal(result.eventsImported, 0, 'no double-import');
  assert.equal(result.filesRenamed, 1, 'file still renamed away');
  assert.equal(listConversationEvents('sess-b').length, 1);
});

test('legacy events.jsonl imports as type event with legacy source', () => {
  const dir = sessionDir('proj-b', 'sess-legacy');
  writeFileSync(
    join(dir, 'events.jsonl'),
    [JSON.stringify({ kind: 'hook-user', text: 'old one' }), JSON.stringify({ kind: 'hook-assistant', text: 'old two' })].join('\n'),
    'utf-8',
  );

  const result = backfillConversationEvents(tmpDir, { logger: quiet });
  assert.equal(result.eventsImported, 2);
  const rows = listConversationEvents('sess-legacy');
  assert.deepEqual(rows.map((r) => r.type), ['event', 'event']);
  assert.equal(rows[0]!.sourceKind, 'legacy-events-jsonl');
  assert.equal(rows[0]!.seq, 1);
  assert.ok(existsSync(join(dir, 'events.jsonl.imported')));
});

test('a session with BOTH logs imports the normalized one and renames both (old preference)', () => {
  const dir = sessionDir('proj-c', 'sess-both');
  writeNormalizedLog(dir, 'sess-both');
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ kind: 'hook-user', text: 'legacy' }), 'utf-8');

  const result = backfillConversationEvents(tmpDir, { logger: quiet });
  assert.equal(result.eventsImported, 2, 'normalized rows only');
  assert.equal(result.filesRenamed, 2, 'both files renamed');
  const rows = listConversationEvents('sess-both');
  assert.deepEqual(rows.map((r) => r.sourceKind), ['claude-jsonl', 'claude-jsonl']);
});
