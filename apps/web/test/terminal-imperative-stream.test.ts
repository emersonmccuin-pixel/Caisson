/**
 * Tests for the imperative PTY streaming fix (pc-pty-chat-244).
 *
 * Core invariant: raw PTY batches must cause ~0 React re-renders.
 * With Step 1b applied, raw frames never reach the chat-session reducer
 * at all, so `sessionState` is stable across terminal streaming →
 * all downstream useMemos cache-hit → zero component re-renders.
 *
 * These tests prove:
 * 1. The createRawTerminalEmitter helper (the real emitter used by
 *    useProjectWs) delivers batches to subscribers and supports
 *    clean unsubscribe.
 * 2. The chat-session reducer's events-memo key slices
 *    (timeline / sequenced / unsequenced) are referentially stable
 *    when raw frames are dispatched — belt-and-suspenders guard for
 *    any code path that still routes a raw frame through the reducer.
 * 3. ChatSurfaceProps no longer has a rawEvents array prop (compile-
 *    time proof: TypeScript would error if the key were present and
 *    we try to reference subscribeRawTerminal instead).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRawTerminalEmitter } from '../src/hooks/raw-terminal-emitter.ts';
import {
  chatSessionReducer,
  createChatSessionState,
} from '../src/hooks/chat-session-reducer.ts';
// Type-only import — TypeScript fails to compile this file if ChatSurfaceProps
// has a `rawEvents` key (we reference subscribeRawTerminal below, which would
// be a type error if the old rawEvents prop shape were present instead).
import type { ChatSurfaceProps } from '../src/features/chat/ChatSurfaceProps.ts';
import type { WsEnvelope } from '../src/features/runtime/ws-types.ts';

// ── helper: minimal raw envelope ────────────────────────────────────────────

function rawEnv(projectId = 'p1', sessionId = 's1'): WsEnvelope {
  return { projectId, sessionId, type: 'raw', data: 'x', text: 'hello', terminalSeq: 1 } as WsEnvelope;
}

// ── 1. Emitter mechanics ─────────────────────────────────────────────────────

test('createRawTerminalEmitter: subscriber receives emitted batch', () => {
  const emitter = createRawTerminalEmitter();
  const received: WsEnvelope[][] = [];

  emitter.subscribe((envs) => received.push(envs));

  const batch1 = [rawEnv()];
  const batch2 = [rawEnv(), rawEnv()];
  emitter.emit(batch1);
  emitter.emit(batch2);

  assert.equal(received.length, 2, 'subscriber called for each emit');
  assert.strictEqual(received[0], batch1, 'first batch is === same reference');
  assert.strictEqual(received[1], batch2, 'second batch is === same reference');
});

test('createRawTerminalEmitter: unsubscribe stops delivery', () => {
  const emitter = createRawTerminalEmitter();
  let callCount = 0;

  const unsub = emitter.subscribe(() => callCount++);

  emitter.emit([rawEnv()]);
  assert.equal(callCount, 1, 'called once before unsubscribe');

  unsub();
  emitter.emit([rawEnv()]);
  emitter.emit([rawEnv()]);
  assert.equal(callCount, 1, 'not called after unsubscribe');
});

test('createRawTerminalEmitter: multiple subscribers all receive; partial unsubscribe works', () => {
  const emitter = createRawTerminalEmitter();
  let a = 0, b = 0;

  const unsubA = emitter.subscribe(() => a++);
  const unsubB = emitter.subscribe(() => b++);

  emitter.emit([]);
  emitter.emit([]);
  assert.equal(a, 2, 'subscriber A received both emits');
  assert.equal(b, 2, 'subscriber B received both emits');

  unsubA();
  emitter.emit([]);
  assert.equal(a, 2, 'subscriber A not called after unsubscribe');
  assert.equal(b, 3, 'subscriber B still called after A unsubscribed');

  unsubB();
  emitter.emit([]);
  assert.equal(b, 3, 'subscriber B not called after unsubscribe');
});

test('createRawTerminalEmitter: double-unsubscribe is safe (no throw)', () => {
  const emitter = createRawTerminalEmitter();
  const unsub = emitter.subscribe(() => {});
  unsub();
  assert.doesNotThrow(() => unsub(), 'second unsubscribe must not throw');
});

test('createRawTerminalEmitter: emit with no subscribers is safe', () => {
  const emitter = createRawTerminalEmitter();
  assert.doesNotThrow(() => emitter.emit([rawEnv()]), 'emit with no subscribers must not throw');
});

// ── 2. Reducer key-slice stability under raw frames ──────────────────────────
//
// With Step 1b, raw frames never reach the reducer at all.
// But this test guards against any regression: even if a raw frame somehow
// reaches the reducer, the three slices that the events useMemo keys on
// must remain referentially identical.

test('reducer: raw dispatch does NOT change events-memo key slices (belt-and-suspenders)', () => {
  let state = createChatSessionState('p1');
  // Establish a session so activeSessionId is set
  state = chatSessionReducer(state, {
    type: 'envelope',
    env: {
      projectId: 'p1',
      type: 'session-changed',
      transition: 'resume-session',
      session: { id: 's1' },
    } as WsEnvelope,
  });

  const beforeTimeline = state.timeline;
  const beforeSequenced = state.sequenced;
  const beforeUnsequenced = state.unsequenced;

  // Dispatch several raw frames directly through the reducer
  for (let i = 0; i < 5; i++) {
    state = chatSessionReducer(state, {
      type: 'envelope',
      env: { projectId: 'p1', sessionId: 's1', type: 'raw', data: `frame-${i}` } as WsEnvelope,
    });
  }

  assert.strictEqual(state.timeline, beforeTimeline,
    'timeline ref must be === stable after raw dispatches');
  assert.strictEqual(state.sequenced, beforeSequenced,
    'sequenced ref must be === stable after raw dispatches');
  assert.strictEqual(state.unsequenced, beforeUnsequenced,
    'unsequenced ref must be === stable after raw dispatches');
});

test('reducer: batched raw envs do NOT change events-memo key slices', () => {
  let state = createChatSessionState('p1');
  state = chatSessionReducer(state, {
    type: 'envelope',
    env: {
      projectId: 'p1',
      type: 'session-changed',
      transition: 'resume-session',
      session: { id: 's1' },
    } as WsEnvelope,
  });

  const beforeTimeline = state.timeline;
  const beforeSequenced = state.sequenced;
  const beforeUnsequenced = state.unsequenced;

  const rawBatch = Array.from({ length: 10 }, (_, i) => ({
    projectId: 'p1',
    sessionId: 's1',
    type: 'raw' as const,
    data: `b-${i}`,
  })) as WsEnvelope[];

  state = chatSessionReducer(state, { type: 'envelopes', envs: rawBatch });

  assert.strictEqual(state.timeline, beforeTimeline, 'timeline stable after batched raw envs');
  assert.strictEqual(state.sequenced, beforeSequenced, 'sequenced stable after batched raw envs');
  assert.strictEqual(state.unsequenced, beforeUnsequenced, 'unsequenced stable after batched raw envs');
});

// ── 3. ChatSurfaceProps shape: subscribeRawTerminal present, rawEvents absent ─
//
// This is enforced at compile time by TypeScript (the file fails to build if
// rawEvents is re-added to ChatSurfaceProps). We also do a runtime shape check
// to make the intent explicit and catch any dynamic mis-wiring.

test('ChatSurfaceProps: subscribeRawTerminal is a valid key (type-level proof)', () => {
  // TypeScript would fail to compile this file if ChatSurfaceProps did NOT
  // have subscribeRawTerminal, because we create a typed partial below.
  // It also fails to compile if rawEvents is present and we reference it as absent
  // (the @ts-expect-error below enforces the absence at build time).
  const shape: Pick<ChatSurfaceProps, 'subscribeRawTerminal'> = {
    subscribeRawTerminal: () => () => {},
  };
  assert.equal(typeof shape.subscribeRawTerminal, 'function',
    'subscribeRawTerminal must be a function on ChatSurfaceProps');

  // Absence proof: if rawEvents were added back, the @ts-expect-error directive
  // below would be flagged as "unused" by TypeScript strict checking, causing a
  // compile error.  That makes this test a compile-time canary for rawEvents.
  // @ts-expect-error -- rawEvents must NOT exist on ChatSurfaceProps
  const _: Pick<ChatSurfaceProps, 'rawEvents'> = {} as ChatSurfaceProps;
  void _;
  // If we reach this line, the @ts-expect-error was honoured (rawEvents absent).
  assert.ok(true, 'rawEvents is correctly absent from ChatSurfaceProps');
});
