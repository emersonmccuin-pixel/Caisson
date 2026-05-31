// Slice 007 — the /api/ask durable ask-shadow (server adapter).
//
// The first pending_interactions writer. A SIDE write around the UNCHANGED
// in-memory resolver in chat-bridges/routes.ts: the shadow row is created `open`
// on ask, terminalized `answered` when the resolver resolves (via the index.ts
// resolvePendingAsk wrapper) or `expired` on the 10-minute timeout, and
// boot-swept to `expired` for orphaned `open` rows. It is INSPECTABLE, NOT the
// answer authority. The hook protocol, the `ask`/`ask-reply` envelopes, and the
// timeout text are untouched.

import {
  PendingInteractionService,
  type PendingInteractionPublication,
} from '@pc/app-services';
import { buildLiveEventFrame } from '@pc/contracts';
import {
  expireOpenPendingInteractions,
  findOpenPendingInteractionBySource,
  newId,
} from '@pc/db';
import type { ULID } from '@pc/domain';

import type { AskShadowPort } from '../features/chat-bridges/routes.ts';

const SOURCE_KIND = 'runtime-hook';

export interface AskShadowDeps {
  interactions?: PendingInteractionService;
  broadcastTo(projectId: ULID, msg: unknown): void;
  now?: () => number;
}

export class AskShadow implements AskShadowPort {
  private readonly interactions: PendingInteractionService;
  private readonly broadcast: (projectId: ULID, msg: unknown) => void;
  private readonly now: () => number;

  constructor(deps: AskShadowDeps) {
    this.interactions = deps.interactions ?? new PendingInteractionService();
    this.broadcast = deps.broadcastTo;
    this.now = deps.now ?? (() => Date.now());
  }

  onAsk(input: { projectId: ULID; toolUseId: string; toolName: string; prompt: string }): void {
    try {
      const existing = findOpenPendingInteractionBySource(SOURCE_KIND, input.toolUseId);
      if (existing) return; // a re-ask for the same toolUseId reuses the open row
      const pub = this.interactions.create({
        id: newId(),
        projectId: input.projectId,
        kind: 'runtime-hook-ask',
        sourceKind: SOURCE_KIND,
        sourceId: input.toolUseId,
        sourceRef: { toolName: input.toolName },
        prompt: input.prompt,
        now: this.now(),
      });
      this.fanout(pub);
    } catch {
      // The shadow is best-effort; never break the blocking /api/ask path.
    }
  }

  /** Called from index.ts when the in-memory resolver resolves an ask-reply. */
  onResolved(toolUseId: string, answer: string): void {
    try {
      const row = findOpenPendingInteractionBySource(SOURCE_KIND, toolUseId);
      if (!row) return;
      this.fanout(this.interactions.answer({ id: row.id, answer, answeredBy: 'user', now: this.now() }));
    } catch {
      // best-effort
    }
  }

  onTimedOut(toolUseId: string): void {
    try {
      const row = findOpenPendingInteractionBySource(SOURCE_KIND, toolUseId);
      if (!row) return;
      this.fanout(this.interactions.expire({ id: row.id, now: this.now() }));
    } catch {
      // best-effort
    }
  }

  private fanout(pub: PendingInteractionPublication | null): void {
    if (!pub) return;
    this.broadcast(pub.interaction.projectId, buildLiveEventFrame(pub.liveEvent));
  }
}

/** Boot sweep: expire orphaned `open` pending_interactions (e.g. an /api/ask
 *  whose HTTP connection was lost on a prior process). Inspectable, not a
 *  resume. Returns the count swept. */
export function sweepOrphanedPendingInteractions(now = Date.now()): number {
  return expireOpenPendingInteractions(now).length;
}
