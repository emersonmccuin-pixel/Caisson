// Stage contract family (slice 003). Browser-safe, zero runtime deps.
//
// Stages live as JSON on `projects.stages` with a `projects.stagesRev`
// revision. They are project-scoped. This module owns the shared `StageDto`
// shape plus the canonical `stage.list.changed` live-event payload contract
// and its parser/guards. It mirrors the project.changed helpers in projects.ts.

import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
  type LiveEventFrame,
} from './live-events.ts';
import { type ULID } from './shared.ts';

export interface StageDto {
  id: string;
  name: string;
  /** Sort key within the project's stage list (low -> high). */
  position: number;
  color?: string;
  isNew?: boolean;
  isDone?: boolean;
  isCancelled?: boolean;
  /** The project-level stages revision at the time this snapshot was taken. */
  rev?: number;
}

export type StageListChangedReason = 'replaced';

export interface StageListChangedLivePayload {
  stagesRev: number;
  stages: StageDto[];
  reason: StageListChangedReason;
}

/** Legacy compatibility projection broadcast under the websocket name
 *  `stages-changed`. Kept additive so existing clients keep working. */
export interface StagesChangedRefetchEnvelope {
  type: 'stages-changed';
  projectId: ULID;
  stagesRev: number;
  stages: StageDto[];
}

export type StageListChangedLiveEvent = LiveEvent<StageListChangedLivePayload> & {
  type: 'stage.list.changed';
  entity: 'stage';
  scope: 'project';
  projectId: ULID;
  entityId: null;
};

export type StageListChangedLiveEventFrame = LiveEventFrame<StageListChangedLivePayload> & {
  event: StageListChangedLiveEvent;
};

export function isStageDto(value: unknown): value is StageDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.position === 'number' &&
    (value.color === undefined || typeof value.color === 'string') &&
    isOptionalBoolean(value.isNew) &&
    isOptionalBoolean(value.isDone) &&
    isOptionalBoolean(value.isCancelled) &&
    (value.rev === undefined || typeof value.rev === 'number')
  );
}

export function isStageListChangedLivePayload(
  value: unknown,
): value is StageListChangedLivePayload {
  if (!isRecord(value)) return false;
  return (
    typeof value.stagesRev === 'number' &&
    Array.isArray(value.stages) &&
    value.stages.every(isStageDto) &&
    value.reason === 'replaced'
  );
}

export function isStageListChangedLiveEvent(value: unknown): value is StageListChangedLiveEvent {
  return (
    isLiveEvent(value) &&
    value.type === 'stage.list.changed' &&
    value.entity === 'stage' &&
    value.scope === 'project' &&
    typeof value.projectId === 'string' &&
    value.entityId === null &&
    isStageListChangedLivePayload(value.payload)
  );
}

export function isStageListChangedLiveEventFrame(
  value: unknown,
): value is StageListChangedLiveEventFrame {
  return isLiveEventFrame(value) && isStageListChangedLiveEvent(value.event);
}

export function buildStagesChangedRefetchEnvelope(input: {
  projectId: ULID;
  stagesRev: number;
  stages: StageDto[];
}): StagesChangedRefetchEnvelope {
  return {
    type: 'stages-changed',
    projectId: input.projectId,
    stagesRev: input.stagesRev,
    stages: input.stages,
  };
}

export function toStagesChangedRefetchEnvelope(
  event: StageListChangedLiveEvent,
): StagesChangedRefetchEnvelope {
  return buildStagesChangedRefetchEnvelope({
    projectId: event.projectId,
    stagesRev: event.payload.stagesRev,
    stages: event.payload.stages,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}
