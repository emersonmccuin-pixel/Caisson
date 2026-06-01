// T3.1 — the chat reducer's `sessionChangedNonce`. The sessions rail keys its
// lifecycle refetch off this monotonic counter (instead of scanning the chat
// `events[]`), so it MUST tick on every session-changed — including a
// resume-to-the-same-id where `activeSessionId` doesn't flip — and on nothing
// else.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chatSessionReducer,
  createChatSessionState,
  type ChatSessionReducerState,
} from '../src/hooks/chat-session-reducer.ts';
import type { WsEnvelope } from '../src/features/runtime/ws-types.ts';

const PROJECT = 'p1';

function withProject(): ChatSessionReducerState {
  return chatSessionReducer(createChatSessionState(null), { type: 'reset-project', projectId: PROJECT });
}

function sessionChanged(sessionId: string, transition: 'new-session' | 'resume-session'): WsEnvelope {
  return {
    projectId: PROJECT,
    type: 'session-changed',
    transition,
    session: { id: sessionId, projectId: PROJECT },
  } as unknown as WsEnvelope;
}

function jsonlUsage(sessionId: string, seq: number): WsEnvelope {
  return {
    projectId: PROJECT,
    sessionId,
    seq,
    type: 'jsonl',
    event: { kind: 'jsonl-usage', inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, model: 'm' },
  } as unknown as WsEnvelope;
}

test('createChatSessionState seeds sessionChangedNonce at 0', () => {
  assert.equal(createChatSessionState(null).sessionChangedNonce, 0);
  assert.equal(createChatSessionState(PROJECT).sessionChangedNonce, 0);
});

test('a new-session session-changed bumps the nonce', () => {
  const s0 = withProject();
  const s1 = chatSessionReducer(s0, { type: 'envelope', env: sessionChanged('sess-1', 'new-session') });
  assert.equal(s1.sessionChangedNonce, s0.sessionChangedNonce + 1);
  assert.equal(s1.activeSessionId, 'sess-1');
});

test('a resume session-changed bumps the nonce — even resuming the SAME id', () => {
  let s = withProject();
  s = chatSessionReducer(s, { type: 'envelope', env: sessionChanged('sess-1', 'new-session') });
  const afterNew = s.sessionChangedNonce;
  // Resume the same active session id: activeSessionId does NOT change, but the
  // nonce must still advance so the rail refetches.
  s = chatSessionReducer(s, { type: 'envelope', env: sessionChanged('sess-1', 'resume-session') });
  assert.equal(s.activeSessionId, 'sess-1');
  assert.equal(s.sessionChangedNonce, afterNew + 1);
});

test('non-session-changed envelopes do NOT bump the nonce', () => {
  let s = withProject();
  s = chatSessionReducer(s, { type: 'envelope', env: sessionChanged('sess-1', 'new-session') });
  const before = s.sessionChangedNonce;
  s = chatSessionReducer(s, { type: 'envelope', env: jsonlUsage('sess-1', 1) });
  assert.equal(s.sessionChangedNonce, before);
});
