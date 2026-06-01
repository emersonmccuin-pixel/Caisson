// Slice 015b — workflow-runs resource-list rewire to the canonical relay frame.
//
// `useProjectWorkflowV2Runs` → `useResourceList` now keys on the generic
// `{type:'live-event'}` frame (entity `workflow-run`) the relay delivers — not
// the legacy `workflow-v2-run-changed` envelope. The web test runner can't
// resolve the `@/` alias, so this pins the load-bearing contract seam: the
// run-change frame's payload carries the full WorkflowRunDto, which the extractor
// adapts to V2RunSummary (workflowSlug → workflowId).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isWorkflowRunChangedLivePayload,
  type LiveEvent,
  type WorkflowRunDto,
} from '@pc/contracts';

function run(over: Partial<WorkflowRunDto> = {}): WorkflowRunDto {
  return {
    id: 'r1',
    projectId: 'p1',
    workflowSlug: 'deploy',
    workflowName: 'Deploy',
    definitionHash: 'h',
    status: 'running',
    rev: 1,
    trigger: 'manual',
    stageId: null,
    workItemId: null,
    worktreePath: null,
    lastReason: null,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
    dagState: { nodes: {} },
    ...over,
  };
}

function frame(r: WorkflowRunDto, reason = 'advanced'): { event: LiveEvent } {
  return {
    event: {
      id: `e-${r.id}-${r.rev}`,
      cursor: String(r.rev),
      scope: 'project',
      projectId: r.projectId,
      type: 'workflow.run.changed',
      entity: 'workflow-run',
      entityId: r.id,
      version: r.rev,
      createdAt: 1,
      payload: { reason, run: r },
    } as LiveEvent,
  };
}

// Verbatim copy of useProjectWorkflowV2Runs' extractFromLiveEvent + adapter.
function extract(event: LiveEvent, projectId: string) {
  if (!isWorkflowRunChangedLivePayload(event.payload)) return null;
  const r = event.payload.run;
  if (!r || r.projectId !== projectId) return null;
  return {
    id: r.id,
    workflowId: r.workflowSlug,
    workflowName: r.workflowName,
    projectId: r.projectId,
    workItemId: r.workItemId,
    trigger: r.trigger,
    stageId: r.stageId,
    status: r.status,
    worktreePath: r.worktreePath,
    lastReason: r.lastReason,
    rev: r.rev,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  };
}

test('extractor adapts a workflow-run frame to V2RunSummary (workflowSlug→workflowId)', () => {
  const rec = extract(frame(run({ rev: 5, status: 'completed' })).event, 'p1');
  assert.ok(rec);
  assert.equal(rec?.id, 'r1');
  assert.equal(rec?.workflowId, 'deploy');
  assert.equal(rec?.rev, 5);
  assert.equal(rec?.status, 'completed');
});

test('extractor rejects a run snapshot for a different project', () => {
  const rec = extract(frame(run({ projectId: 'other' })).event, 'p1');
  assert.equal(rec, null);
});

test('extractor skips a payload with no run snapshot', () => {
  const ev = frame(run()).event;
  delete (ev.payload as { run?: unknown }).run;
  assert.equal(extract(ev, 'p1'), null);
});
