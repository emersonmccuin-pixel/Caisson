// Slice 015b — announcing write-door for orchestrator session-title changes.
//
// A session-title change is a small DB-owned fact. The writer writes a durable
// `session.title.changed` live_outbox row in-txn (carrying the full session row
// so the rail / chat title bar apply without a refetch); the live-relay drains
// the committed row and fans the canonical frame to the project's subscribers.
// Replaces the old hand-written `session-title-updated` envelope.
//
// NEVER call the relay/broadcast inside the txn — just `insertLiveEvent`; the
// relay drains the committed row post-commit.

import type { OrchestratorSession, ULID } from '@pc/domain';
import { getDb, insertLiveEvent } from '@pc/db';

/** Write a durable `session.title.changed` outbox row for a project's active
 *  session. The payload carries the full session row. */
export function announceSessionTitle(projectId: ULID, session: OrchestratorSession): void {
  getDb().transaction((tx) => {
    insertLiveEvent(tx, {
      scope: 'project',
      projectId,
      type: 'session.title.changed',
      entity: 'session-title',
      entityId: session.id,
      version: null,
      payload: { session },
    });
  });
}
