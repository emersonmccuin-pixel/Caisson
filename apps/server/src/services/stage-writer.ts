// Slice 015b — announcing write-door for project stage-list changes.
//
// Stages live as JSON on `projects.stages` with a monotonic `projects.stagesRev`.
// A bulk replace announces a durable `stage.list.changed` live_outbox row; the
// live-relay drains the committed row and fans the canonical `{type:'live-event'}`
// frame to the project's subscribers. Replaces the old hand-written
// `stages-changed` envelope fanout.
//
// NEVER call the relay/broadcast inside the txn — just `insertLiveEvent`; the
// relay drains the committed row post-commit.

import type { Stage, ULID } from '@pc/domain';
import type { StageListChangedLivePayload } from '@pc/contracts';
import { getDb, insertLiveEvent } from '@pc/db';

/** Write a durable `stage.list.changed` outbox row for a project's replaced
 *  stage list. `stamped` carries each stage's new `rev` (from updateProjectStages). */
export function announceStageList(projectId: ULID, stamped: Stage[]): void {
  const stagesRev = (stamped[0] as { rev?: number } | undefined)?.rev ?? 0;
  const payload: StageListChangedLivePayload = {
    stagesRev,
    // Domain Stage is a superset of the contract StageDto.
    stages: stamped as unknown as StageListChangedLivePayload['stages'],
    reason: 'replaced',
  };
  getDb().transaction((tx) => {
    insertLiveEvent(tx, {
      scope: 'project',
      projectId,
      type: 'stage.list.changed',
      entity: 'stage',
      entityId: null,
      version: stagesRev,
      payload,
    });
  });
}
