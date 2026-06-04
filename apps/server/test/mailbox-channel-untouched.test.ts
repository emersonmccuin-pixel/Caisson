import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Slice 007 stop-condition guard: the mailbox platform must NOT touch Channel,
// agent_inbox, enqueueAndPush, postChannel, or emitToSession. Cutover is slice
// 008. This is a static import-boundary check on the slice's server modules.
//
// M4a (2026-06-04) — NO-INBOX-WRITE: the agent_inbox path is DELETED whole
// (hook + repo + tables archived by migration 0041; FD-12 bypass #3 executed).
// The second test keeps it dead.

const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const MAILBOX_MODULES = [
  'services/mailbox-worker.ts',
  'services/mailbox-orchestrator-turn-adapter.ts',
  'services/ask-shadow.ts',
  'features/mailbox/routes.ts',
];

const BANNED = [
  /channel-server/,
  /agent-delivery/,
  /enqueueAndPush/,
  /postChannel/,
  /emitToSession/,
  /drainPendingForSession/,
];

/** Strip // line comments and block comments so the BANNED check matches real
 *  code references, not the explanatory "NEVER calls enqueueAndPush" comments. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('mailbox platform server modules never reference Channel / agent-delivery paths', () => {
  const violations: string[] = [];
  for (const rel of MAILBOX_MODULES) {
    const source = stripComments(readFileSync(`${srcDir}/${rel}`, 'utf8'));
    for (const pattern of BANNED) {
      if (pattern.test(source)) violations.push(`${rel}: ${pattern}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('NO-INBOX-WRITE (M4a): the agent_inbox path stays deleted', () => {
  // The hook is gone (legacy-runtime-cleanup keeps its NAME to scrub old
  // installs — that's the one allowed mention).
  assert.equal(
    existsSync(`${repoRoot}/templates/.claude/hooks/inbox-drain.cjs`),
    false,
    'inbox-drain.cjs must not regrow',
  );
  // The settings template no longer wires it.
  const template = readFileSync(`${repoRoot}/templates/.claude/settings.template.json`, 'utf8');
  assert.ok(!template.includes('inbox-drain'), 'settings template must not reference inbox-drain');
  // The repo is gone.
  assert.equal(
    existsSync(`${repoRoot}/packages/db/src/repos/agent-inbox.ts`),
    false,
    'repos/agent-inbox.ts must not regrow',
  );
  // No live schema definition for the archived tables (comments stripped — the
  // tombstone note may name them).
  const schema = stripComments(
    readFileSync(`${repoRoot}/packages/db/src/schema-agent-system.ts`, 'utf8'),
  );
  assert.ok(!/sqliteTable\(\s*'agent_inbox'/.test(schema), 'agent_inbox table must not regrow');
  assert.ok(
    !/sqliteTable\(\s*'agent_delivery_audit'/.test(schema),
    'agent_delivery_audit table must not regrow',
  );
});
