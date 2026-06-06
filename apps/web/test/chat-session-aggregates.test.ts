import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregatesFromEvents,
  chatSessionReducer,
  createChatSessionState,
  EMPTY_AGGREGATES,
  materializeChatSessionEvents,
  materializeTerminalRawEvents,
  type ChatSessionReducerAction,
  type ChatSessionReducerState,
} from '../src/hooks/chat-session-reducer.ts';
import type { WsEnvelope } from '../src/features/runtime/ws-types.ts';

/**
 * Simulates the React useMemo behaviour for the events array, keyed on the
 * three chat-tier slices that materializeChatSessionEvents actually reads.
 * Returns the SAME array reference when those slices have not changed.
 * This mirrors the fix in use-project-ws.ts and makes referential-stability
 * assertable (===) in plain node:test without a React render.
 */
function makeEventsMemo() {
  let cachedTimeline: ChatSessionReducerState['timeline'] | null = null;
  let cachedSequenced: ChatSessionReducerState['sequenced'] | null = null;
  let cachedUnsequenced: ChatSessionReducerState['unsequenced'] | null = null;
  let cachedResult: WsEnvelope[] | null = null;
  return (state: ChatSessionReducerState): WsEnvelope[] => {
    if (
      cachedResult !== null &&
      cachedTimeline === state.timeline &&
      cachedSequenced === state.sequenced &&
      cachedUnsequenced === state.unsequenced
    ) {
      return cachedResult;
    }
    cachedTimeline = state.timeline;
    cachedSequenced = state.sequenced;
    cachedUnsequenced = state.unsequenced;
    cachedResult = materializeChatSessionEvents(state);
    return cachedResult;
  };
}

const PROJECT = 'p1';
const SESSION = 'sess-1';

let seqCounter = 0;
function nextSeq(): number {
  return ++seqCounter;
}

function usageEnv(
  partial: Partial<{
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    model: string | null;
  }>,
  seq = nextSeq(),
  sessionId = SESSION,
): WsEnvelope {
  return {
    projectId: PROJECT,
    sessionId,
    seq,
    type: 'jsonl',
    event: {
      kind: 'jsonl-usage',
      inputTokens: partial.inputTokens ?? 0,
      outputTokens: partial.outputTokens ?? 0,
      cacheCreationTokens: partial.cacheCreationTokens ?? 0,
      cacheReadTokens: partial.cacheReadTokens ?? 0,
      model: partial.model ?? null,
      speed: null,
      cacheMissReason: null,
    },
  };
}

function sessionStateEnv(state: string, seq = nextSeq()): WsEnvelope {
  return {
    projectId: PROJECT,
    sessionId: SESSION,
    seq,
    type: 'jsonl',
    event: { kind: 'jsonl-session-state', state, permissionMode: null, timestamp: null, raw: null },
  };
}

function turnDurationEnv(durationMs: number | null, seq = nextSeq()): WsEnvelope {
  return {
    projectId: PROJECT,
    sessionId: SESSION,
    seq,
    type: 'jsonl',
    event: {
      kind: 'jsonl-turn-duration',
      durationMs,
      budgetTokens: null,
      messageCount: null,
      timestamp: null,
      raw: null,
    },
  };
}

function toolCallEnv(seq = nextSeq()): WsEnvelope {
  return {
    projectId: PROJECT,
    sessionId: SESSION,
    seq,
    type: 'jsonl',
    event: { kind: 'jsonl-tool-call', toolUseId: `t-${seq}`, name: 'Read', input: {} },
  };
}

function rawEnv(): WsEnvelope {
  return { projectId: PROJECT, sessionId: SESSION, type: 'raw', data: 'x' };
}

function sendAckEnv(clientMessageId: string): WsEnvelope {
  return {
    projectId: PROJECT,
    sessionId: SESSION,
    type: 'send-ack',
    clientMessageId,
    ok: true,
    status: 'received',
  };
}

function dispatch(state: ChatSessionReducerState, env: WsEnvelope): ChatSessionReducerState {
  return chatSessionReducer(state, { type: 'envelope', env });
}

function dispatchAll(
  start: ChatSessionReducerState,
  actions: ChatSessionReducerAction[],
): ChatSessionReducerState {
  return actions.reduce((s, a) => chatSessionReducer(s, a), start);
}

// Option A correctness: raw PTY frames must NOT appear in materializeChatSessionEvents
// so that the chat timeline's events[] reference stays stable across terminal batches.
test('raw frames are excluded from materializeChatSessionEvents', () => {
  let state = createChatSessionState(PROJECT);
  const chatEnvBefore = materializeChatSessionEvents(state);

  // Dispatch a raw frame
  state = dispatch(state, rawEnv());

  const chatEnvAfter = materializeChatSessionEvents(state);
  // Chat events unchanged — no raw frames in the output
  assert.deepEqual(chatEnvAfter, chatEnvBefore);
  assert.equal(
    chatEnvAfter.some((e) => e.type === 'raw'),
    false,
    'materializeChatSessionEvents must not contain raw envelopes',
  );
});

test('raw frames appear in materializeTerminalRawEvents', () => {
  let state = createChatSessionState(PROJECT);
  assert.equal(materializeTerminalRawEvents(state).length, 0);

  const r1 = rawEnv();
  const r2 = rawEnv();
  state = dispatch(state, r1);
  state = dispatch(state, r2);

  const raw = materializeTerminalRawEvents(state);
  assert.equal(raw.length, 2);
  assert.equal(raw.every((e) => e.type === 'raw'), true);
});

// Referential-stability: the events[] reference must NOT change on pure terminal batches.
// This is the core perf invariant — if it breaks, all chat-timeline useMemo hooks fire
// 20×/sec during terminal streaming even though no chat content changed.
test('events[] ref is === stable across pure terminal raw batches (useMemo simulation)', () => {
  const memo = makeEventsMemo();
  let state = createChatSessionState(PROJECT);

  // Apply a chat event so events[] is non-empty
  const chatEnv = usageEnv({ inputTokens: 5, model: 'm1' }, 1);
  state = dispatch(state, chatEnv);

  const eventsRef0 = memo(state);           // first call — computes
  const rawRef0 = materializeTerminalRawEvents(state);

  // Apply 3 raw batches — only terminalRaw/nextOrdinal/activeSessionId change
  state = dispatch(state, rawEnv());
  state = dispatch(state, rawEnv());
  state = dispatch(state, rawEnv());

  const eventsRef1 = memo(state);           // must return SAME reference
  const rawRef1 = materializeTerminalRawEvents(state);

  assert.strictEqual(eventsRef0, eventsRef1, 'events[] ref must be === stable across raw batches');
  assert.notStrictEqual(rawRef0, rawRef1, 'rawEvents ref must change after raw batches');
  assert.equal(rawRef1.length, 3, 'rawEvents must contain all 3 raw frames');

  // Also verify the underlying slice refs are unchanged (what the useMemo keying relies on)
  // After appendTerminalRaw the spread ...state preserves timeline/sequenced/unsequenced refs.
  const timelineRef = state.timeline;
  const sequencedRef = state.sequenced;
  state = dispatch(state, rawEnv());
  assert.strictEqual(state.timeline, timelineRef, 'timeline ref stable after raw dispatch');
  assert.strictEqual(state.sequenced, sequencedRef, 'sequenced ref stable after raw dispatch');
});

test('chat events still appear in materializeChatSessionEvents after raw frames', () => {
  let state = createChatSessionState(PROJECT);
  state = dispatch(state, rawEnv());
  state = dispatch(state, rawEnv());
  const usageEnvelope = usageEnv({ inputTokens: 5, outputTokens: 2, model: 'm1' });
  state = dispatch(state, usageEnvelope);
  state = dispatch(state, rawEnv());

  const chat = materializeChatSessionEvents(state);
  // The chat events should contain the usage envelope (jsonl type), not the raw ones
  assert.ok(chat.length > 0, 'chat events must be non-empty after jsonl event');
  assert.ok(chat.some((e) => e.type === 'jsonl'), 'jsonl event must appear in chat events');
  assert.equal(chat.some((e) => e.type === 'raw'), false, 'no raw frames in chat events');
});

test('incremental aggregates == brute-force oracle (usage stream)', () => {
  let state = createChatSessionState(PROJECT);
  const inputs = [
    { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 1, cacheReadTokens: 2, model: 'm1' },
    { inputTokens: 7, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 4, model: 'm1' },
    { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 9, cacheReadTokens: 9, model: 'm2' },
  ];
  for (const u of inputs) state = dispatch(state, usageEnv(u));
  const oracle = aggregatesFromEvents(materializeChatSessionEvents(state));
  assert.deepEqual(state.aggregates.usage, oracle.usage);
  assert.deepEqual(state.aggregates.usage, {
    inputTokens: 117,
    outputTokens: 58,
    cacheCreationTokens: 10,
    cacheReadTokens: 15,
  });
  assert.equal(state.aggregates.latestModel, 'm2');
});

test('incremental aggregates == oracle (mixed stream)', () => {
  let state = createChatSessionState(PROJECT);
  state = dispatch(state, usageEnv({ inputTokens: 5, outputTokens: 2, model: 'm1' }));
  state = dispatch(state, toolCallEnv());
  state = dispatch(state, sessionStateEnv('running'));
  state = dispatch(state, turnDurationEnv(1234));
  state = dispatch(state, rawEnv());
  state = dispatch(state, usageEnv({ inputTokens: 1, outputTokens: 1, model: 'm1' }));
  const oracle = aggregatesFromEvents(materializeChatSessionEvents(state));
  assert.deepEqual(state.aggregates.usage, oracle.usage);
  assert.equal(state.aggregates.latestSessionState, oracle.latestSessionState);
  assert.equal(state.aggregates.lastTurnDurationMs, oracle.lastTurnDurationMs);
  assert.equal(state.aggregates.latestModel, oracle.latestModel);
});

test('latest-wins for session-state / turn-duration; null model does not clear latestModel', () => {
  let state = createChatSessionState(PROJECT);
  state = dispatch(state, sessionStateEnv('idle'));
  state = dispatch(state, sessionStateEnv('running'));
  state = dispatch(state, sessionStateEnv('requires_action'));
  assert.equal(state.aggregates.latestSessionState, 'requires_action');

  state = dispatch(state, turnDurationEnv(100));
  state = dispatch(state, turnDurationEnv(200));
  state = dispatch(state, turnDurationEnv(null)); // null does not overwrite
  assert.equal(state.aggregates.lastTurnDurationMs, 200);

  state = dispatch(state, usageEnv({ inputTokens: 1, model: 'mX' }));
  assert.equal(state.aggregates.latestModel, 'mX');
  state = dispatch(state, usageEnv({ inputTokens: 1, model: null }));
  assert.equal(state.aggregates.latestModel, 'mX'); // null model preserves prior
});

test('reset clears aggregates; resume does not', () => {
  let state = createChatSessionState(PROJECT);
  state = dispatch(state, usageEnv({ inputTokens: 50, model: 'm1' }));
  assert.equal(state.aggregates.usage.inputTokens, 50);

  // reset-project
  const afterReset = chatSessionReducer(state, { type: 'reset-project', projectId: PROJECT });
  assert.deepEqual(afterReset.aggregates, EMPTY_AGGREGATES);

  // session-changed: new-session
  const afterNew = dispatch(state, {
    projectId: PROJECT,
    type: 'session-changed',
    transition: 'new-session',
    session: { id: 'sess-2' },
  } as WsEnvelope);
  assert.deepEqual(afterNew.aggregates, EMPTY_AGGREGATES);

  // session-changed: resume-session does NOT reset
  const afterResume = dispatch(state, {
    projectId: PROJECT,
    type: 'session-changed',
    transition: 'resume-session',
    session: { id: SESSION },
  } as WsEnvelope);
  assert.equal(afterResume.aggregates.usage.inputTokens, 50);
  assert.equal(afterResume.aggregates, state.aggregates); // pass-through, same ref
});

test('stable identity when envelope contributes nothing', () => {
  let state = createChatSessionState(PROJECT);
  state = dispatch(state, usageEnv({ inputTokens: 1, model: 'm1' }));
  const prevAgg = state.aggregates;

  const afterTool = dispatch(state, toolCallEnv());
  assert.equal(afterTool.aggregates, prevAgg); // same reference

  const afterRaw = dispatch(afterTool, rawEnv());
  assert.equal(afterRaw.aggregates, prevAgg);

  const afterAck = dispatch(afterRaw, sendAckEnv('cm-1'));
  assert.equal(afterAck.aggregates, prevAgg);
});

test('no double-count on re-delivery; replay is idempotent', () => {
  let state = createChatSessionState(PROJECT);
  const env = usageEnv({ inputTokens: 20, outputTokens: 10, model: 'm1' }, 9001);
  state = dispatch(state, env);
  assert.equal(state.aggregates.usage.inputTokens, 20);
  // re-deliver SAME sessionId:seq → dedupe branch, must NOT re-fold
  state = dispatch(state, env);
  assert.equal(state.aggregates.usage.inputTokens, 20);
  assert.equal(state.aggregates.usage.outputTokens, 10);

  // Replaying the same action list from the same start yields identical aggregates.
  const start = createChatSessionState(PROJECT);
  const actions: ChatSessionReducerAction[] = [
    { type: 'envelope', env: usageEnv({ inputTokens: 3, model: 'm1' }, 1) },
    { type: 'envelope', env: toolCallEnv(2) },
    { type: 'envelope', env: usageEnv({ inputTokens: 4, model: 'm2' }, 3) },
  ];
  const once = dispatchAll(start, actions);
  const twice = dispatchAll(start, actions);
  assert.deepEqual(once.aggregates, twice.aggregates);
});

test('batched envelopes produce the same projection as sequential envelopes', () => {
  const envs = [
    rawEnv(),
    rawEnv(),
    usageEnv({ inputTokens: 3, outputTokens: 1, model: 'm1' }, 101),
    rawEnv(),
  ];
  const start = createChatSessionState(PROJECT);
  const sequential = envs.reduce((s, env) => dispatch(s, env), start);
  const batched = chatSessionReducer(start, { type: 'envelopes', envs });

  assert.deepEqual(materializeChatSessionEvents(batched), materializeChatSessionEvents(sequential));
  assert.deepEqual(batched.aggregates, sequential.aggregates);
});

test('snapshot re-seeds aggregates from the replay set', () => {
  // Live state with prior usage that the snapshot does NOT carry forward.
  let state = createChatSessionState(PROJECT);
  state = dispatch(state, usageEnv({ inputTokens: 999, model: 'live' }, 5000, 'old-sess'));

  const replayEnv: WsEnvelope = {
    projectId: PROJECT,
    type: 'session-replay',
    sessionId: SESSION,
    highWaterSeq: 3,
    events: [
      { type: 'jsonl', sessionId: SESSION, seq: 1, event: { kind: 'jsonl-usage', inputTokens: 10, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, model: 'snap', speed: null, cacheMissReason: null } },
      { type: 'jsonl', sessionId: SESSION, seq: 2, event: { kind: 'jsonl-usage', inputTokens: 5, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 0, model: 'snap', speed: null, cacheMissReason: null } },
      { type: 'jsonl', sessionId: SESSION, seq: 3, event: { kind: 'jsonl-session-state', state: 'idle', permissionMode: null, timestamp: null, raw: null } },
    ],
  };
  const after = dispatch(state, replayEnv);
  assert.deepEqual(after.aggregates.usage, {
    inputTokens: 15,
    outputTokens: 3,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
  assert.equal(after.aggregates.latestModel, 'snap');
  assert.equal(after.aggregates.latestSessionState, 'idle');
});

test('trim does not corrupt cumulative totals', () => {
  let state = createChatSessionState(PROJECT);
  const MANY = 10_050; // > MAX_TIMELINE_ENTRIES (10_000)
  let expectedInput = 0;
  for (let i = 0; i < MANY; i++) {
    expectedInput += 1;
    state = dispatch(state, usageEnv({ inputTokens: 1, model: 'm1' }, i + 1));
  }
  // Timeline was trimmed, but aggregates reflect ALL usage rows.
  assert.ok(state.timeline.length <= 10_000);
  assert.equal(state.aggregates.usage.inputTokens, expectedInput);
  assert.equal(state.aggregates.usage.inputTokens, MANY);
});
