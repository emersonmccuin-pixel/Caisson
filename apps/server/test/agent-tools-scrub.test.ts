// M7 (FD-6) — dead-grant boot sweep: stored agent rows lose ☠ pc_ask_user
// through the audited updateAgent door; user-edit drift-lock is preserved
// (the audit reason must NOT look system-authored).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-tools-scrub-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createAgent, getAgentById, listAgentAudit, runMigrations } = await import('@pc/db');
const { scrubDeadToolGrants, DEAD_TOOL_GRANTS } = await import('../src/services/agent-tools-scrub.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const audit = { actor: 'user' as const, reason: 'test' };

test('scrub removes dead grants, keeps live tools, is idempotent, audits without unlocking reseed', () => {
  // createAgent merges REQUIRED tools; plant the dead grant explicitly (it is
  // no longer in REQUIRED_AGENT_TOOLS post-M7).
  const dirty = createAgent(
    {
      name: `dirty-${Math.random().toString(36).slice(2, 7)}`,
      scope: 'global',
      tools: ['Read', 'mcp__pc-rig__pc_ask_user', 'Grep'],
    },
    audit,
  );
  assert.ok(dirty.tools.includes('mcp__pc-rig__pc_ask_user'), 'precondition: dead grant stored');

  const clean = createAgent(
    { name: `clean-${Math.random().toString(36).slice(2, 7)}`, scope: 'global', tools: ['Read'] },
    audit,
  );
  const cleanToolsBefore = [...clean.tools];

  const first = scrubDeadToolGrants();
  assert.equal(first.scrubbed, 1, 'exactly the dirty row scrubbed');
  assert.match(first.rows[0]!, /^dirty-/);

  const scrubbed = getAgentById(dirty.id as ULID)!;
  assert.ok(!scrubbed.tools.includes('mcp__pc-rig__pc_ask_user'), 'dead grant gone');
  assert.ok(scrubbed.tools.includes('Read') && scrubbed.tools.includes('Grep'), 'live tools kept');

  // Untouched row stays byte-identical.
  assert.deepEqual(getAgentById(clean.id as ULID)!.tools, cleanToolsBefore);

  // Idempotent.
  const second = scrubDeadToolGrants();
  assert.equal(second.scrubbed, 0);

  // Audit row exists and must NOT carry the system-seed/reseed prefixes —
  // those break pod-seed-with-drift's user-edit chain and would let future
  // drift-reseeds stomp user customizations.
  const rows = listAgentAudit({ agentId: dirty.id as ULID, limit: 10 });
  const scrubRow = rows.find((r) => (r.reason ?? '').startsWith('m7-fd6-dead-grant-scrub'));
  assert.ok(scrubRow, 'audited through the updateAgent door');
  assert.ok(!(scrubRow!.reason ?? '').startsWith('system-seed:'));
  assert.ok(!(scrubRow!.reason ?? '').startsWith('system-reseed:'));
});

test('DEAD_TOOL_GRANTS names are not in REQUIRED_AGENT_TOOLS (or the merge would replant them)', async () => {
  const { REQUIRED_AGENT_TOOLS } = await import('@pc/domain');
  for (const dead of DEAD_TOOL_GRANTS) {
    assert.ok(!REQUIRED_AGENT_TOOLS.includes(dead), `${dead} must stay out of the required set`);
  }
});
