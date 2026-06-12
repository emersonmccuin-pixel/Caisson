// Slice 015b-tail — announcing write-door for agents (pods).
//
// A pod change is a DB-owned fact (the `agents` roster the Agents tab renders).
// The writer writes a durable `pod.changed` live_outbox row IN-TXN; the
// live-relay drains the committed row post-commit and fans the canonical
// `{type:'live-event', event}` frame to the right subscribers. Replaces the old
// hand-written `pod-changed` broadcastAll envelope (no more bypass).
//
// Scope: a GLOBAL pod emits a global frame (relay → broadcastAll → every project
// socket, so each Agents tab's stock-globals refresh); a PROJECT pod emits a
// project frame for its owning project (relay → broadcast(projectId)). The
// payload is minimal — the roster refetches on the frame, it does not apply the
// snapshot inline — so `version` is left null (no per-record dedup needed).
//
// NEVER call the relay/broadcast inside the txn — just `insertLiveEvent`; the
// relay drains the committed row post-commit.

import type { ULID, PodScope } from '@pc/domain';
import type { PodChangedKind } from '@pc/contracts';
import { getAgentById, getDb, insertLiveEvent } from '@pc/db';

/** Emit a `pod.changed` outbox row for a live (non-deleted) pod. Reads the row
 *  back for its scope/projectId so the frame is routed correctly. No-ops if the
 *  row is gone. Pass `change: 'created'` for new rows. */
export function announcePod(id: ULID, change: 'created' | 'updated' = 'updated'): void {
  const pod = getAgentById(id);
  if (!pod) return;
  writePodChanged({ podId: id, name: pod.name, change, scope: pod.scope, projectId: pod.projectId });
}

/** Emit a `pod.changed` outbox row scoped to a specific project — used when
 *  attaching or detaching an agent from a project. Routes the frame to that
 *  project's socket regardless of the agent's own scope. No-ops if the agent
 *  row is gone (post-delete membership cleanup should not be needed, but
 *  guard for correctness). */
export function announcePodToProject(id: ULID, targetProjectId: ULID): void {
  const pod = getAgentById(id);
  if (!pod) return;
  writePodChanged({ podId: id, name: pod.name, change: 'updated', scope: 'project', projectId: targetProjectId });
}

/** Emit a `pod.changed` outbox row for a pod that was just soft-deleted (no
 *  longer readable via getAgentById). The caller supplies the row's scope +
 *  projectId (captured before the delete) so the frame routes correctly. */
export function announcePodDeleted(
  podId: ULID,
  name: string,
  scope: PodScope,
  projectId: ULID | null,
): void {
  writePodChanged({ podId, name, change: 'deleted', scope, projectId });
}

function writePodChanged(input: {
  podId: ULID;
  name: string;
  change: PodChangedKind;
  scope: PodScope;
  projectId: ULID | null;
}): void {
  const scope = input.scope === 'project' ? 'project' : 'global';
  getDb().transaction((tx) => {
    insertLiveEvent(tx, {
      scope,
      projectId: scope === 'project' ? input.projectId : null,
      type: 'pod.changed',
      entity: 'pod',
      entityId: input.podId,
      version: null,
      payload: { change: input.change, podId: input.podId, name: input.name },
    });
  });
}
