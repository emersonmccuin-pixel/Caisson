// Section 25 Session 8 — pod-revision helper for v2 drift detection.
//
// Design §6.4 wants a stable signal for "this pod's content changed
// between dispatch and resume." The agents table's `updated_at` is the
// primary driver — every mutating route refreshes it. Agent-scoped context
// docs (migration 0055 — formerly agent_knowledge) have their own
// `updated_at`, and since the v2 materialiser lists them in the `.md` footer
// at spawn time, a doc edit also changes the resumed agent's view; we
// incorporate it.
//
// Format: `agent:<ts>.k:<max-doc-ts>`. Both epoch ms. The string is
// opaque — equality is the only consumer. NULL when the pod row doesn't
// exist.

import { and, desc, eq, isNull, max } from 'drizzle-orm';

import type { ULID } from '@pc/domain';

import { getDb } from '../connection.ts';
import { agents, contextDocs } from '../schema.ts';

export interface ComputePodRevisionInput {
  podName: string;
  /** Project scope. Null for global pods. */
  projectId?: ULID | null;
}

/** Compute the opaque revision string for a pod, or null if no live row
 *  matches. */
export function computePodRevision(input: ComputePodRevisionInput): string | null {
  const db = getDb();
  const projectId = input.projectId ?? null;

  const agentRow = db
    .select({ id: agents.id, updatedAt: agents.updatedAt })
    .from(agents)
    .where(
      and(
        eq(agents.name, input.podName),
        projectId === null ? isNull(agents.projectId) : eq(agents.projectId, projectId),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .get();

  if (!agentRow) return null;

  const docMax = db
    .select({ ts: max(contextDocs.updatedAt) })
    .from(contextDocs)
    .where(and(eq(contextDocs.agentId, agentRow.id), isNull(contextDocs.deletedAt)))
    .get();

  const docTs = docMax?.ts ?? 0;
  return `agent:${agentRow.updatedAt}.k:${docTs}`;
}

/** True iff both revisions are non-null and differ. */
export function podRevisionsDiffer(
  before: string | null,
  after: string | null,
): boolean {
  if (before == null || after == null) return false;
  return before !== after;
}
