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

import {
  buildLiveEventFrame,
  parseMailboxAddress,
  type MailboxAddress,
  type MailboxDeliveryChangedLivePayload,
} from '@pc/contracts';
import type {
  MailboxDeliveryPublication,
  MailboxService,
} from '@pc/app-services';
import {
  getActiveOrchestratorSession,
  listDueDeliveries,
  type MailboxDeliveryRow,
} from '@pc/db';
import type { ULID } from '@pc/domain';

import type {
  MailboxOrchestratorTurnAdapter,
} from './mailbox-orchestrator-turn-adapter.ts';

export type MailboxBroadcast = (projectId: ULID | null, event: unknown) => void;

export interface MailboxWorkerDeps {
  service: MailboxService;
  orchestratorTurn: MailboxOrchestratorTurnAdapter;
  broadcast: MailboxBroadcast;
  /** Resolve a message's projectId for fanout scope. */
  getMessageProjectId: (messageId: ULID) => ULID | null;
  /** Resolve a recipient's address. */
  getRecipientAddress: (recipientId: ULID) => MailboxAddress | null;
  /** Resolve a message body for the orchestrator-turn channel. */
  getMessageBody: (messageId: ULID) => string | null;
  leaseOwner?: string;
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;

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
      ...deps,
    };
  }

  /** Run one drain pass. Returns counts for logging/tests. */
  runOnce(limit = 50): { leased: number; accepted: number; retried: number; deadLettered: number } {
    let leased = 0;
    let accepted = 0;
    let retried = 0;
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
      else if (outcome === 'dead-lettered') deadLettered += 1;
    }
    return { leased, accepted, retried, deadLettered };
  }

  private attempt(delivery: MailboxDeliveryRow): 'accepted' | 'retried' | 'dead-lettered' {
    const now = this.d.now();
    const fail = (error: string, retryable: boolean): 'retried' | 'dead-lettered' => {
      // attempts on the row is the count BEFORE this attempt; +1 = this attempt.
      const attemptsAfter = delivery.attempts + 1;
      if (!retryable || attemptsAfter >= this.d.maxAttempts) {
        this.fanout(
          this.d.service.deadLetterDelivery({
            deliveryId: delivery.id,
            messageId: delivery.messageId,
            recipientId: delivery.recipientId,
            reason: retryable ? 'max-retries' : 'non-retryable',
            lastError: error,
            now,
          }),
        );
        return 'dead-lettered';
      }
      this.fanout(
        this.d.service.retryDelivery({
          deliveryId: delivery.id,
          lastError: error,
          nextAttemptAt: now + backoffMs(attemptsAfter),
          now,
        }),
      );
      return 'retried';
    };

    if (delivery.channel === 'ui-inbox') {
      // "Available in the inbox": the recipient row exists from enqueue, so
      // acceptance is immediate. UI read/action is recipient state, not this.
      this.fanout(
        this.d.service.acceptDelivery({
          deliveryId: delivery.id,
          targetRefKind: 'ui-inbox',
          targetRefId: delivery.recipientId,
          now,
        }),
      );
      return 'accepted';
    }

    if (delivery.channel === 'orchestrator-turn') {
      const address = this.d.getRecipientAddress(delivery.recipientId);
      const session = address ? resolveOrchestratorSession(address) : null;
      if (!session) return fail('no orchestrator session resolvable', false);
      const body = this.d.getMessageBody(delivery.messageId);
      if (body === null) return fail('message body missing', false);
      const result = this.d.orchestratorTurn.deliver({
        projectId: session.projectId,
        sessionId: session.sessionId,
        deliveryId: delivery.id,
        text: body,
      });
      if (result.ok) {
        this.fanout(
          this.d.service.acceptDelivery({
            deliveryId: delivery.id,
            targetRefKind: 'send-queue',
            targetRefId: result.sendQueueId,
            now,
          }),
        );
        return 'accepted';
      }
      return fail(result.error, result.retryable);
    }

    // compat-channel is reserved but NOT wired this slice.
    return fail(`unsupported delivery channel: ${delivery.channel}`, false);
  }

  private fanout(pub: MailboxDeliveryPublication | null): void {
    if (!pub) return;
    const projectId = this.d.getMessageProjectId(pub.delivery.messageId);
    this.d.broadcast(projectId, buildLiveEventFrame(pub.liveEvent));
  }
}

interface ResolvedSession {
  projectId: ULID;
  sessionId: ULID;
}

function resolveOrchestratorSession(address: MailboxAddress): ResolvedSession | null {
  if (address.kind === 'orchestrator-session') {
    return { projectId: address.projectId as ULID, sessionId: address.sessionId as ULID };
  }
  if (address.kind === 'active-orchestrator') {
    const active = getActiveOrchestratorSession(address.projectId as ULID);
    if (!active) return null;
    return { projectId: address.projectId as ULID, sessionId: active.id };
  }
  return null;
}

export { parseMailboxAddress };
export type { MailboxDeliveryChangedLivePayload };
