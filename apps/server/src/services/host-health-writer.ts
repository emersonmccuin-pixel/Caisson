// T1.1 — announcing write-door for host-connection liveness.
//
// The HostConnection state machine flips connected/reconnecting/down; this
// writer records each transition as a durable global `host-health.changed`
// live_outbox row (constant entityId so the pill is one store slot). The 250ms
// relay drain sweep fans the canonical frame to every project socket.
//
// NEVER call the relay/broadcast inside the txn — just `insertLiveEvent`.

import type { ULID } from '@pc/domain';
import type { HostHealthSnapshot } from '@pc/contracts';
import { getDb, insertLiveEvent } from '@pc/db';

/** Stable sentinel entityId — the store skips null-entityId frames, and a
 *  constant key dedupes every update into exactly one pill slot. (Not a real
 *  ULID; the outbox `entity_id` column is plain text — the brand is compile-time.) */
const HOST_HEALTH_ENTITY_ID = 'host-health' as ULID;

/** Write a durable `host-health.changed` global outbox row. Last-write-wins
 *  (version null); the monotonic outbox cursor orders transitions. */
export function announceHostHealth(health: HostHealthSnapshot): void {
  getDb().transaction((tx) => {
    insertLiveEvent(tx, {
      scope: 'global',
      projectId: null,
      type: 'host-health.changed',
      entity: 'host-health',
      entityId: HOST_HEALTH_ENTITY_ID,
      version: null,
      payload: { health },
    });
  });
}
