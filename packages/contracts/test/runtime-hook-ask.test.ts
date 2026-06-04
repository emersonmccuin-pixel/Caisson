import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isRuntimeHookAskResponse,
  parseRuntimeHookAskRequest,
} from '../src/index.ts';

test('parseRuntimeHookAskRequest mirrors the /api/ask body', () => {
  const ok = parseRuntimeHookAskRequest({
    projectId: 'p1',
    sessionId: 's1',
    toolName: 'AskUserQuestion',
    toolUseId: 'tu1',
    toolInput: { q: 'a?' },
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.sessionId, 's1');
    assert.deepEqual(ok.value.toolInput, { q: 'a?' });
  }
  // sessionId optional -> null
  const noSession = parseRuntimeHookAskRequest({ projectId: 'p1', toolName: 't', toolUseId: 'tu' });
  assert.equal(noSession.ok, true);
  if (noSession.ok) assert.equal(noSession.value.sessionId, null);

  assert.equal(parseRuntimeHookAskRequest({ toolName: 't', toolUseId: 'tu' }).ok, false);
  assert.equal(parseRuntimeHookAskRequest({ projectId: 'p', toolUseId: 'tu' }).ok, false);
  assert.equal(parseRuntimeHookAskRequest({ projectId: 'p', toolName: 't' }).ok, false);
});

// ☠ M8/FD-7: the optional interactionId (reserved for the shadow row) is gone.
test('isRuntimeHookAskResponse mirrors { answer }', () => {
  assert.equal(isRuntimeHookAskResponse({ answer: 'yes' }), true);
  assert.equal(isRuntimeHookAskResponse({ answer: 9 }), false);
  assert.equal(isRuntimeHookAskResponse({}), false);
});
