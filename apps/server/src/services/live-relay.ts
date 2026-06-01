// Slice 015a — the single live-event relay.
//
// One post-commit drainer. Gateways write a `live_outbox` row inside their DB
// transaction (`insertLiveEvent`); AFTER the transaction commits, something
// calls `relay.drain()`. The relay reads the committed rows past its delivered
// cursor and fans each to the subscribed sockets per scope/project, advancing
// the cursor. This is the "announce ≡ durable write, delivery is separate"
// split from the ADR: the durable write can never roll back because delivery
// failed, and a zero-subscriber row stays replayable (it lives in the outbox
// until pruned).
//
// CRITICAL (ADR Non-goal): never call `drain()` inside a `db.transaction(...)`
// closure — the rows it reads are only guaranteed committed post-commit, and
// delivering mid-transaction would announce a write that may still roll back.
//
// 015a ships the relay BESIDE the existing hand fanout (dual delivery). The
// client dedupes by event `id` + per-entity `version`, so a row delivered by
// both the relay and a legacy `broadcast*` call is harmless. 015b deletes the
// legacy fanout one subsystem at a time as the relay proves it delivers.

import {
  buildLiveEventFrame,
  type LiveEventResetFrame,
} from '@pc/contracts';
import type { ULID } from '@pc/domain';
import {
  getLiveEventHighWater,
  listLiveEventsAfter,
  listLiveOutboxRowsAfter,
  type LiveOutboxEvent,
} from '@pc/db';

export interface LiveRelayHub {
  /** Fan a project-scoped frame to that project's subscribers. */
  broadcast(projectId: ULID, msg: unknown): number;
  /** Fan a global frame to every subscriber. */
  broadcastAll(msg: unknown): number;
}

/** A single open socket, for the per-socket subscribe handshake. */
export interface LiveRelaySocket {
  readonly OPEN: number;
  readyState: number;
  send(data: string): void;
}

export interface LiveRelayDeps {
  hub: LiveRelayHub;
  /** Override for tests; defaults to the DB repo. Used by the per-socket
   *  catch-up handshake (scope/project-filtered + resetRequired). */
  listEventsAfter?: typeof listLiveEventsAfter;
  /** Override for tests; defaults to the DB repo. The relay's live drain reads
   *  the raw mixed-scope stream and routes each row by its own scope. */
  listRowsAfter?: typeof listLiveOutboxRowsAfter;
  highWater?: typeof getLiveEventHighWater;
}

const DRAIN_BATCH_LIMIT = 500;

export class LiveRelay {
  private readonly hub: LiveRelayHub;
  private readonly listEventsAfter: typeof listLiveEventsAfter;
  private readonly listRowsAfter: typeof listLiveOutboxRowsAfter;
  private readonly highWater: typeof getLiveEventHighWater;
  /** The max `seq` already fanned to live subscribers. `null` = nothing yet. */
  private deliveredCursor: number | null = null;
  private draining = false;
  private redrain = false;

  constructor(deps: LiveRelayDeps) {
    this.hub = deps.hub;
    this.listEventsAfter = deps.listEventsAfter ?? listLiveEventsAfter;
    this.listRowsAfter = deps.listRowsAfter ?? listLiveOutboxRowsAfter;
    this.highWater = deps.highWater ?? getLiveEventHighWater;
  }

  /** Adopt the current outbox head as the starting cursor without replaying the
   *  backlog as live frames. Call once at boot so the relay only fans rows
   *  committed from now on (historical rows reach clients via the handshake
   *  replay, not a startup flood). */
  primeToHead(): void {
    const head = this.highWater();
    this.deliveredCursor = head === null ? 0 : Number(head);
  }

  /** Post-commit drain. Reads every committed outbox row past the delivered
   *  cursor and fans it per scope/project, then advances the cursor. Re-entrant
   *  safe: a `drain()` arriving mid-drain coalesces into one more pass. */
  drain(): void {
    if (this.draining) {
      this.redrain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.redrain = false;
        this.drainOnce();
      } while (this.redrain);
    } finally {
      this.draining = false;
    }
  }

  private drainOnce(): void {
    if (this.deliveredCursor === null) this.primeToHead();
    let cursor = this.deliveredCursor ?? 0;
    // Global and per-project rows interleave in one gapless `seq` stream. Page
    // the raw mixed stream (`listLiveOutboxRowsAfter`) and route each row by its
    // own scope — `listLiveEventsAfter` with no projectId returns global-only,
    // which would silently drop every project row.
    for (;;) {
      const rows = this.listRowsAfter(String(cursor), DRAIN_BATCH_LIMIT);
      if (rows.length === 0) break;
      for (const event of rows) this.fan(event);
      cursor = Number(rows[rows.length - 1].cursor);
      this.deliveredCursor = cursor;
      if (rows.length < DRAIN_BATCH_LIMIT) break;
    }
  }

  private fan(event: LiveOutboxEvent): void {
    const frame = buildLiveEventFrame(toContractEvent(event));
    if (event.scope === 'global') {
      this.hub.broadcastAll(frame);
    } else if (event.projectId) {
      this.hub.broadcast(event.projectId as ULID, frame);
    }
  }

  /**
   * Per-socket subscribe handshake (ADR §"WS cursor cut-over"). Snapshot the
   * current max `seq`, replay `(lastVersion, snapshot]` to THIS socket, then the
   * caller's existing hub subscription (attached on connect) takes over for live
   * rows — interleave-safe because any live row with `seq ≤ snapshot` is a dup
   * the client discards by `id`/`version`. If `lastVersion` predates the pruned
   * floor, send a `live-reset` instead so the client refetches HTTP truth.
   *
   * `projectId` scopes the per-project catch-up; pass `null` for the global/
   * all-projects socket (global rows only).
   */
  catchUp(socket: LiveRelaySocket, lastVersion: string | undefined, projectId: ULID | null): void {
    if (socket.readyState !== socket.OPEN) return;
    // Cold load (no cursor): the client just fetched HTTP truth. Nothing to
    // replay — live rows flow from the relay once subscribed.
    if (lastVersion === undefined) return;

    let cursor = lastVersion;
    for (;;) {
      const batch = this.listEventsAfter(
        projectId
          ? { after: cursor, projectId, includeGlobal: true, limit: DRAIN_BATCH_LIMIT }
          : { after: cursor, limit: DRAIN_BATCH_LIMIT },
      );
      if (batch.resetRequired) {
        const reset: LiveEventResetFrame = {
          type: 'live-reset',
          projectId,
          cursor: this.highWater(),
        };
        this.sendTo(socket, reset);
        return;
      }
      for (const event of batch.events) {
        this.sendTo(socket, buildLiveEventFrame(toContractEvent(event)));
      }
      cursor = batch.nextCursor ?? cursor;
      if (batch.events.length < DRAIN_BATCH_LIMIT) break;
    }
  }

  private sendTo(socket: LiveRelaySocket, msg: unknown): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      /* best-effort; the keepalive sweep reaps a dead socket */
    }
  }
}

function toContractEvent(event: LiveOutboxEvent): {
  id: ULID;
  cursor: string;
  scope: 'project' | 'global';
  projectId: ULID | null;
  type: string;
  entity: LiveOutboxEvent['entity'];
  entityId: ULID | null;
  version: number | null;
  createdAt: number;
  payload: unknown;
} {
  return {
    id: event.id,
    cursor: event.cursor,
    scope: event.scope,
    projectId: event.projectId,
    type: event.type,
    entity: event.entity,
    entityId: event.entityId,
    version: event.version,
    createdAt: event.createdAt,
    payload: event.payload,
  };
}
