// Unit tests for the deriveActiveSessionProjectIds pure derivation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveActiveSessionProjectIds,
  isActiveChatSession,
} from '../src/hooks/live-session-project-ids.ts';
import type { WsEnvelope } from '../src/features/runtime/ws-types.ts';

// Helper: build a session-changed envelope
function sessionChanged(
  projectId: string,
  status: 'active' | 'ended' | null,
): WsEnvelope {
  return {
    type: 'session-changed',
    projectId,
    session:
      status === null
        ? null
        : { id: 'sess-1', projectId, status, provider: 'claude' },
  } as WsEnvelope;
}

// ── isActiveChatSession ──────────────────────────────────────────────────────

test('isActiveChatSession: active session → true', () => {
  assert.equal(
    isActiveChatSession(sessionChanged('p1', 'active')),
    true,
  );
});

test('isActiveChatSession: ended session → false', () => {
  assert.equal(
    isActiveChatSession(sessionChanged('p1', 'ended')),
    false,
  );
});

test('isActiveChatSession: null session → false', () => {
  assert.equal(
    isActiveChatSession(sessionChanged('p1', null)),
    false,
  );
});

test('isActiveChatSession: non session-changed envelope → false', () => {
  assert.equal(
    isActiveChatSession({ type: 'event', projectId: 'p1' } as WsEnvelope),
    false,
  );
});

// ── deriveActiveSessionProjectIds ────────────────────────────────────────────

test('empty streams → empty set', () => {
  const result = deriveActiveSessionProjectIds([], []);
  assert.equal(result.size, 0);
});

test('single active session in active events → project in set', () => {
  const result = deriveActiveSessionProjectIds(
    [sessionChanged('p1', 'active')],
    [],
  );
  assert.equal(result.has('p1'), true);
  assert.equal(result.size, 1);
});

test('single ended session in active events → project NOT in set', () => {
  const result = deriveActiveSessionProjectIds(
    [sessionChanged('p1', 'ended')],
    [],
  );
  assert.equal(result.has('p1'), false);
  assert.equal(result.size, 0);
});

test('null session → project NOT in set', () => {
  const result = deriveActiveSessionProjectIds(
    [sessionChanged('p1', null)],
    [],
  );
  assert.equal(result.has('p1'), false);
});

test('multiple projects, mixed states', () => {
  const result = deriveActiveSessionProjectIds(
    [
      sessionChanged('p1', 'active'),
      sessionChanged('p2', 'ended'),
      sessionChanged('p3', 'active'),
    ],
    [],
  );
  assert.equal(result.has('p1'), true);
  assert.equal(result.has('p2'), false);
  assert.equal(result.has('p3'), true);
  assert.equal(result.size, 2);
});

test('active events state overridden by background: session closes in background', () => {
  // Active events saw an active session; background sees it closed (user
  // switched away and the session was then closed by the server).
  const result = deriveActiveSessionProjectIds(
    [sessionChanged('p1', 'active')],
    [sessionChanged('p1', null)],
  );
  assert.equal(result.has('p1'), false);
});

test('background events state: active session only visible in background stream', () => {
  const result = deriveActiveSessionProjectIds(
    [],
    [sessionChanged('p2', 'active')],
  );
  assert.equal(result.has('p2'), true);
});

test('latest session-changed per project wins (last in array)', () => {
  // First envelope: active; second: closed → should not be in set.
  const result = deriveActiveSessionProjectIds(
    [
      sessionChanged('p1', 'active'),
      sessionChanged('p1', null), // session closed later
    ],
    [],
  );
  assert.equal(result.has('p1'), false);
});

test('latest session-changed per project wins (re-opened)', () => {
  const result = deriveActiveSessionProjectIds(
    [
      sessionChanged('p1', null), // was closed
      sessionChanged('p1', 'active'), // then re-opened
    ],
    [],
  );
  assert.equal(result.has('p1'), true);
});

test('non session-changed events are ignored', () => {
  const result = deriveActiveSessionProjectIds(
    [
      { type: 'event', projectId: 'p1', event: {} } as WsEnvelope,
      { type: 'runtime-state', projectId: 'p1' } as WsEnvelope,
    ],
    [],
  );
  assert.equal(result.size, 0);
});

test('missing projectId in envelope is skipped', () => {
  const result = deriveActiveSessionProjectIds(
    [
      {
        type: 'session-changed',
        projectId: null,
        session: { status: 'active' },
      } as WsEnvelope,
    ],
    [],
  );
  assert.equal(result.size, 0);
});
