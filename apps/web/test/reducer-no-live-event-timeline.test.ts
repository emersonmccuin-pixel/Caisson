// T3.3 — the cut. Relay `live-event` frames are early-returned in the WS handler
// and must NEVER enter the chat-session timeline; the live store is their sole
// path. This pins the reducer end: a live-event envelope dispatched into the
// reducer does not grow the timeline, while a real chat envelope does.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chatSessionReducer,
  createChatSessionState,
  materializeChatSessionEvents,
  type ChatSessionReducerState,
} from '../src/hooks/chat-session-reducer.ts';
import type { WsEnvelope } from '../src/features/runtime/ws-types.ts';

const PROJECT = 'p1';

function withProject(): ChatSessionReducerState {
  return chatSessionReducer(createChatSessionState(null), { type: 'reset-project', projectId: PROJECT });
}

// A relay live-event frame carries its scope in event.projectId (no top-level
// projectId) — exactly what the WS handler now early-returns to the store.
function liveEventFrame(entityId: string): WsEnvelope {
  return {
    type: 'live-event',
    event: {
      type: 'work-item.changed',
      entity: 'work-item',
      entityId,
      projectId: PROJECT,
      version: 1,
      cursor: `c-${entityId}`,
      payload: { reason: 'updated', workItem: { id: entityId } },
    },
  } as unknown as WsEnvelope;
}

function chatEvent(sessionId: string, ts: string): WsEnvelope {
  return {
    projectId: PROJECT,
    sessionId,
    type: 'event',
    event: { kind: 'assistant', text: 'hi', ts },
  } as unknown as WsEnvelope;
}

test('a live-event frame does NOT grow the chat timeline', () => {
  const s0 = withProject();
  const before = materializeChatSessionEvents(s0).length;
  const s1 = chatSessionReducer(s0, { type: 'envelope', env: liveEventFrame('wi-1') });
  const after = materializeChatSessionEvents(s1).length;
  assert.equal(after, before, 'timeline must not grow on a live-event frame');
  assert.equal(
    materializeChatSessionEvents(s1).some((e) => (e as { type?: string }).type === 'live-event'),
    false,
    'no live-event frame may appear in the materialized timeline',
  );
});

test('a real chat envelope DOES grow the timeline (control)', () => {
  const s0 = withProject();
  const before = materializeChatSessionEvents(s0).length;
  const s1 = chatSessionReducer(s0, { type: 'envelope', env: chatEvent('sess-1', '2026-06-01T00:00:00.000Z') });
  assert.ok(materializeChatSessionEvents(s1).length > before, 'a chat event must enter the timeline');
});

test('a new-session reset does not resurrect any live-event frame', () => {
  let s = withProject();
  s = chatSessionReducer(s, { type: 'envelope', env: liveEventFrame('wi-1') });
  s = chatSessionReducer(s, {
    type: 'envelope',
    env: { projectId: PROJECT, type: 'session-changed', transition: 'new-session', session: { id: 'sess-1', projectId: PROJECT } } as unknown as WsEnvelope,
  });
  assert.equal(
    materializeChatSessionEvents(s).some((e) => (e as { type?: string }).type === 'live-event'),
    false,
  );
});
