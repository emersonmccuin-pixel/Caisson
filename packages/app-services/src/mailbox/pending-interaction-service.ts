// PendingInteractionService (slice 007) — the durable write door for a
// pending_interactions row's create/answer/cancel/expire lifecycle. Mirrors the
// single-transaction outbox-write-door pattern: mutate -> insert the
// pending-interaction.changed fact in the SAME tx -> re-read -> publication.
// A rollback emits nothing. Project-scoped only (projectId is non-null).
//
// This does NOT own product transitions (agent resume / workflow complete stay
// in their owners) and is NOT the /api/ask blocking answer authority (the
// in-memory resolver stays authoritative; this is the durable shadow).
//
// Boundary purity: @pc/contracts + @pc/db + @pc/domain only.

import type { PendingInteractionChangedLivePayload } from '@pc/contracts';
import {
  answerPendingInteraction as defaultAnswer,
  cancelPendingInteraction as defaultCancel,
  createPendingInteraction as defaultCreate,
  expirePendingInteraction as defaultExpire,
  getDb,
  insertLiveEvent,
  type CreatePendingInteractionInput,
  type DbExecutor,
  type InsertLiveEventDraft,
  type LiveOutboxEvent,
  type PendingInteractionRow,
} from '@pc/db';
import type { ULID } from '@pc/domain';
import { toPendingInteractionDto } from './adapters.ts';

export interface PendingInteractionPublication {
  liveEvent: LiveOutboxEvent<PendingInteractionChangedLivePayload>;
  interaction: PendingInteractionRow;
}

export interface PendingInteractionServiceDeps {
  transaction?: <T>(fn: (tx: DbExecutor) => T) => T;
  insertLiveEvent?: typeof insertLiveEvent;
  createPendingInteraction?: typeof defaultCreate;
  answerPendingInteraction?: typeof defaultAnswer;
  cancelPendingInteraction?: typeof defaultCancel;
  expirePendingInteraction?: typeof defaultExpire;
}

export class PendingInteractionService {
  private readonly tx: <T>(fn: (tx: DbExecutor) => T) => T;
  private readonly insert: typeof insertLiveEvent;
  private readonly createRepo: typeof defaultCreate;
  private readonly answerRepo: typeof defaultAnswer;
  private readonly cancelRepo: typeof defaultCancel;
  private readonly expireRepo: typeof defaultExpire;

  constructor(deps: PendingInteractionServiceDeps = {}) {
    this.tx = deps.transaction ?? ((fn) => getDb().transaction(fn));
    this.insert = deps.insertLiveEvent ?? insertLiveEvent;
    this.createRepo = deps.createPendingInteraction ?? defaultCreate;
    this.answerRepo = deps.answerPendingInteraction ?? defaultAnswer;
    this.cancelRepo = deps.cancelPendingInteraction ?? defaultCancel;
    this.expireRepo = deps.expirePendingInteraction ?? defaultExpire;
  }

  create(input: CreatePendingInteractionInput): PendingInteractionPublication {
    return this.tx((tx) => {
      const interaction = this.createRepo(input, tx);
      const liveEvent = this.insert(tx, buildDraft(interaction));
      return { liveEvent, interaction };
    });
  }

  answer(input: {
    id: ULID;
    answer: string;
    answeredBy: 'orchestrator' | 'user';
    now: number;
  }): PendingInteractionPublication | null {
    return this.terminalize((tx) => this.answerRepo(input, tx));
  }

  cancel(input: { id: ULID; now: number }): PendingInteractionPublication | null {
    return this.terminalize((tx) => this.cancelRepo(input.id, input.now, tx));
  }

  expire(input: { id: ULID; now: number }): PendingInteractionPublication | null {
    return this.terminalize((tx) => this.expireRepo(input.id, input.now, tx));
  }

  private terminalize(
    mutate: (tx: DbExecutor) => PendingInteractionRow | null,
  ): PendingInteractionPublication | null {
    return this.tx((tx) => {
      const interaction = mutate(tx);
      if (!interaction) return null;
      const liveEvent = this.insert(tx, buildDraft(interaction));
      return { liveEvent, interaction };
    });
  }
}

function buildDraft(
  interaction: PendingInteractionRow,
): InsertLiveEventDraft<PendingInteractionChangedLivePayload> {
  const dto = toPendingInteractionDto(interaction);
  return {
    scope: 'project',
    projectId: interaction.projectId,
    type: 'pending-interaction.changed',
    entity: 'pending-interaction',
    entityId: interaction.id,
    version: dto.version,
    payload: {
      interactionId: dto.id,
      kind: dto.kind,
      status: dto.status,
      version: dto.version,
    },
  };
}
