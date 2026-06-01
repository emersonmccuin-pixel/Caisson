// T3.2b — Orchestrator session-title selection (`latestSessionFromTitleEvents`).
// session-changed stays a separate (events-scan) lifecycle trigger; this only
// covers the relay session-title fact → latest-by-cursor.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LiveEvent } from '@pc/contracts';

import { latestSessionFromTitleEvents } from '../src/features/runtime/session-title-live-events.ts';

function titleEv(cursor: string, sessionId: string, title: string): LiveEvent {
  return {
    id: `st-${cursor}`,
    cursor,
    scope: 'project',
    projectId: 'p1',
    type: 'session.title.changed',
    entity: 'session-title',
    entityId: sessionId as never,
    version: null,
    createdAt: 1,
    payload: { session: { id: sessionId, title } } as never,
  };
}

test('picks the session from the highest-cursor title frame', () => {
  const out = latestSessionFromTitleEvents([
    titleEv('3', 's1', 'old'),
    titleEv('9', 's1', 'newest'),
    titleEv('5', 's1', 'mid'),
  ]);
  assert.equal((out as { title?: string } | null)?.title, 'newest');
});

test('returns null when no title frame carries a session', () => {
  assert.equal(latestSessionFromTitleEvents([]), null);
});
