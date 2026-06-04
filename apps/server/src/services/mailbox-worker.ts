// Slice 007 — mailbox delivery worker (server-owned). Additive; alongside
// Channel (no cutover — `compat-channel` is NOT wired this slice).
//
// One pass: list due deliveries -> acquire an exclusive lease -> attempt by
// channel -> accept (with target_ref) / retry (backoff) / dead-letter. A single
// in-process worker runs today, but the lease keeps the model restart-safe.
//
// Delivery is at-least-once attempts with at-most-one effect: the orchestrator-
// turn adapter uses a stable clientMessageId so a reclaimed/retried delivery
// returns the SAME send-queue row. A delivery attempt NEVER answers/resumes an
// interaction; a repeated delivery is safe because action commands validate
// current state. Live events are visibility nudges — acceptance does NOT depend
// on the outbox publication.
//
// Slice 015b — delivery `mailbox.delivery.changed` frames are the relay's job.
// `acceptDelivery`/`retryDelivery`/`deadLetterDelivery` write the canonical
// `live_outbox` row inside their mutation txn; the 250ms relay drains it to the
// right scope/project. The worker no longer hand-fans; the `broadcast`/
// `getMessageProjectId` deps are gone.

import {
  parseMailboxAddress,
  type MailboxAddress,
  type MailboxDeliveryChangedLivePayload,
} from '@pc/contracts';
import type {
  MailboxService,
} from '@pc/app-services';
import {
  getActiveOrchestratorSession,
  getOrchestratorSession,
  listDueDeliveries,
  type MailboxDeliveryRow,
} from '@pc/db';
import type { ULID } from '@pc/domain';

import type {
  MailboxOrchestratorTurnAdapter,
} from './mailbox-orchestrator-turn-adapter.ts';

export interface MailboxWorkerDeps {
  service: MailboxService;
  orchestratorTurn: MailboxOrchestratorTurnAdapter;
  /** Resolve a recipient's address. */
  getRecipientAddress: (recipientId: ULID) => MailboxAddress | null;
  /** Resolve a message body for the orchestrator-turn channel. */
  getMessageBody: (messageId: ULID) => string | null;
  /** Resolve a message kind (agent-terminal, workflow-review, …) for the
   *  FD-3/FD-6 system-marker fallback on injected turns. */
  getMessageKind?: (messageId: ULID) => string | null;
  leaseOwner?: string;
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
/** M4a/FD-8 — recheck cadence while waiting for an orchestrator to exist. */
const DEFER_RECHECK_MS = 60_000;

/** Exponential-ish backoff: 1s, 2s, 4s, … capped at 60s. */
function backoffMs(attempts: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempts));
}

export class MailboxWorker {
  private readonly d: Required<Omit<MailboxWorkerDeps, never>> & MailboxWorkerDeps;

  constructor(deps: MailboxWorkerDeps) {
    this.d = {
      leaseOwner: deps.leaseOwner ?? `mailbox-worker-${process.pid}`,
      leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS,
      maxAttempts: deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      now: deps.now ?? (() => Date.now()),
      getMessageKind: deps.getMessageKind ?? (() => null),
      ...deps,
    };
  }

  /** Run one drain pass. Returns counts for logging/tests. */
  runOnce(limit = 50): {
    leased: number;
    accepted: number;
    retried: number;
    deferred: number;
    deadLettered: number;
  } {
    let leased = 0;
    let accepted = 0;
    let retried = 0;
    let deferred = 0;
    let deadLettered = 0;
    const now = this.d.now();
    const due = listDueDeliveries(now, limit);
    for (const row of due) {
      const acquired = this.d.service.lease({
        deliveryId: row.id,
        owner: this.d.leaseOwner,
        now: this.d.now(),
        leaseMs: this.d.leaseMs,
      });
      if (!acquired) continue;
      leased += 1;
      const outcome = this.attempt(acquired);
      if (outcome === 'accepted') accepted += 1;
      else if (outcome === 'retried') retried += 1;
      else if (outcome === 'deferred') deferred += 1;
      else if (outcome === 'dead-lettered') deadLettered += 1;
    }
    return { leased, accepted, retried, deferred, deadLettered };
  }

  private attempt(
    delivery: MailboxDeliveryRow,
  ): 'accepted' | 'retried' | 'deferred' | 'dead-lettered' {
    const now = this.d.now();
    const fail = (error: string, retryable: boolean): 'retried' | 'dead-lettered' => {
      // attempts on the row is the count BEFORE this attempt; +1 = this attempt.
      const attemptsAfter = delivery.attempts + 1;
      if (!retryable || attemptsAfter >= this.d.maxAttempts) {
        // Outbox row written in the txn; the relay delivers the delivery frame.
        this.d.service.deadLetterDelivery({
          deliveryId: delivery.id,
          messageId: delivery.messageId,
          recipientId: delivery.recipientId,
          reason: retryable ? 'max-retries' : 'non-retryable',
          lastError: error,
          now,
        });
        return 'dead-lettered';
      }
      this.d.service.retryDelivery({
        deliveryId: delivery.id,
        lastError: error,
        nextAttemptAt: now + backoffMs(attemptsAfter),
        now,
      });
      return 'retried';
    };

    if (delivery.channel === 'ui-inbox') {
      // "Available in the inbox": the recipient row exists from enqueue, so
      // acceptance is immediate. UI read/action is recipient state, not this.
      this.d.service.acceptDelivery({
        deliveryId: delivery.id,
        targetRefKind: 'ui-inbox',
        targetRefId: delivery.recipientId,
        now,
      });
      return 'accepted';
    }

    if (delivery.channel === 'orchestrator-turn') {
      const address = this.d.getRecipientAddress(delivery.recipientId);
      if (!address) return fail('recipient address missing', false);
      const resolved = resolveOrchestratorSession(address);
      // M4a/FD-8 — "no message silently dies":
      //  · a pinned session that DOESN'T EXIST is permanently undeliverable
      //    (synthetic dispatcher id / purged session) → dead-letter, honestly.
      //  · a project whose orchestrator is merely AWAY is a wait, not a
      //    failure → DEFER (no attempt consumed; recheck on a cadence). The
      //    old code dead-lettered this on the FIRST pass — the
      //    "persists and drains on its next pass" promise was false.
      if (resolved.kind === 'never') {
        return fail(resolved.reason, false);
      }
      if (resolved.kind === 'not-yet') {
        this.d.service.deferDelivery({
          deliveryId: delivery.id,
          reason: resolved.reason,
          nextAttemptAt: now + DEFER_RECHECK_MS,
          now,
        });
        return 'deferred';
      }
      const session = resolved.session;
      const body = this.d.getMessageBody(delivery.messageId);
      if (body === null) return fail('message body missing', false);
      const result = this.d.orchestratorTurn.deliver({
        projectId: session.projectId,
        sessionId: session.sessionId,
        deliveryId: delivery.id,
        text: body,
        kind: this.d.getMessageKind?.(delivery.messageId) ?? null,
      });
      if (result.ok) {
        this.d.service.acceptDelivery({
          deliveryId: delivery.id,
          targetRefKind: 'send-queue',
          targetRefId: result.sendQueueId,
          now,
        });
        return 'accepted';
      }
      return fail(result.error, result.retryable);
    }

    // compat-channel is reserved but NOT wired this slice.
    return fail(`unsupported delivery channel: ${delivery.channel}`, false);
  }
}

interface ResolvedSession {
  projectId: ULID;
  sessionId: ULID;
}

/** M4a — three-way resolution so the worker can tell "will never deliver"
 *  (dead-letter) from "cannot deliver YET" (defer, no attempt consumed). */
type SessionResolution =
  | { kind: 'ok'; session: ResolvedSession }
  | { kind: 'not-yet'; reason: string }
  | { kind: 'never'; reason: string };

function resolveOrchestratorSession(address: MailboxAddress): SessionResolution {
  if (address.kind === 'orchestrator-session') {
    // The address pins a SPECIFIC session — it must actually exist (the old
    // code passed it through blindly; synthetic workflow dispatcher ids then
    // burned five retries each before dead-lettering).
    const session = getOrchestratorSession(address.sessionId as ULID);
    if (!session) {
      return { kind: 'never', reason: `orchestrator session does not exist: ${address.sessionId}` };
    }
    return {
      kind: 'ok',
      session: { projectId: address.projectId as ULID, sessionId: address.sessionId as ULID },
    };
  }
  if (address.kind === 'active-orchestrator') {
    const active = getActiveOrchestratorSession(address.projectId as ULID);
    if (!active) {
      return { kind: 'not-yet', reason: 'no active orchestrator yet — waiting' };
    }
    return {
      kind: 'ok',
      session: { projectId: address.projectId as ULID, sessionId: active.id },
    };
  }
  return { kind: 'never', reason: `unsupported orchestrator-turn address: ${address.kind}` };
}

export { parseMailboxAddress };
export type { MailboxDeliveryChangedLivePayload };
