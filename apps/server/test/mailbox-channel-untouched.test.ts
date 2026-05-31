import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Slice 007 stop-condition guard: the mailbox platform must NOT touch Channel,
// agent_inbox, enqueueAndPush, postChannel, or emitToSession. Cutover is slice
// 008. This is a static import-boundary check on the slice's server modules.

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

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
