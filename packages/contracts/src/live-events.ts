import { parseErr, parseOk, type ParseResult, type ULID } from './shared.ts';

export type LiveEventScope = 'project' | 'global';
export type LiveEventEntity =
  | 'project'
  | 'project-claude-md'
  | 'work-item'
  | 'stage'
  | 'field-schema'
  | 'attachment'
  | 'workflow-definition'
  | 'workflow-run'
  | 'workflow-review'
  | 'agent-run'
  | 'mailbox-message'
  | 'pending-interaction'
  | 'session-title'
  | 'pod';

/** Canonical live-event type names. Replay accepts these for `type=` filtering. */
export type LiveEventTypeName =
  | 'project.changed'
  | 'project.claude-md.changed'
  | 'work-item.changed'
  | 'stage.list.changed'
  | 'field-schema.list.changed'
  | 'attachment.changed'
  | 'workflow.run.changed'
  | 'workflow.review.changed'
  | 'workflow.definition.changed'
  | 'agent.run.changed'
  | 'mailbox.message.changed'
  | 'mailbox.delivery.changed'
  | 'pending-interaction.changed'
  | 'session.title.changed'
  | 'pod.changed';

const LIVE_EVENT_TYPE_NAMES: readonly LiveEventTypeName[] = [
  'project.changed',
  'project.claude-md.changed',
  'work-item.changed',
  'stage.list.changed',
  'field-schema.list.changed',
  'attachment.changed',
  'workflow.run.changed',
  'workflow.review.changed',
  'workflow.definition.changed',
  'agent.run.changed',
  'mailbox.message.changed',
  'mailbox.delivery.changed',
  'pending-interaction.changed',
  'session.title.changed',
  'pod.changed',
];

export function isLiveEventTypeName(value: unknown): value is LiveEventTypeName {
  return (
    typeof value === 'string' && (LIVE_EVENT_TYPE_NAMES as readonly string[]).includes(value)
  );
}

export interface LiveEvent<TPayload = unknown> {
  id: ULID;
  cursor: string;
  scope: LiveEventScope;
  projectId: ULID | null;
  type: string;
  entity: LiveEventEntity;
  entityId: ULID | null;
  version: number | null;
  createdAt: number;
  payload: TPayload;
}

export interface LiveEventFrame<TPayload = unknown> {
  type: 'live-event';
  event: LiveEvent<TPayload>;
}

/**
 * Slice 015a — WS subscribe handshake (client → server). Sent on every
 * (re)connect. `lastVersion` is the global `seq` cursor (the max `seq` the
 * client has already applied); omit it on a cold load that just fetched HTTP
 * truth. The server replays `(lastVersion, snapshot]` then attaches the live
 * relay; the client dedupes replayed/live overlap by event `id` + per-entity
 * `version`. `projectId` scopes the per-project catch-up (the global cursor is
 * sent separately by the global/all-projects socket).
 */
export interface LiveEventSubscribe {
  type: 'subscribe';
  lastVersion?: string;
  projectId?: ULID;
}

/**
 * Slice 015a — server → client gap signal. Emitted during the handshake when
 * the client's `lastVersion` predates the pruned outbox floor, so a complete
 * replay is impossible. The client drops its cursor and refetches HTTP truth
 * for the affected domain(s). `cursor` is the current high-water the client
 * should adopt after it has reloaded.
 */
export interface LiveEventResetFrame {
  type: 'live-reset';
  projectId: ULID | null;
  cursor: string | null;
}

export function isLiveEventSubscribe(value: unknown): value is LiveEventSubscribe {
  if (!isRecord(value) || value.type !== 'subscribe') return false;
  if (value.lastVersion !== undefined && !isLiveEventCursor(value.lastVersion)) return false;
  if (value.projectId !== undefined && (typeof value.projectId !== 'string' || !value.projectId)) {
    return false;
  }
  return true;
}

export function isLiveEventResetFrame(value: unknown): value is LiveEventResetFrame {
  return (
    isRecord(value) &&
    value.type === 'live-reset' &&
    (value.projectId === null || typeof value.projectId === 'string') &&
    (value.cursor === null || isLiveEventCursor(value.cursor))
  );
}

export interface ListLiveEventsQuery {
  after?: string;
  projectId?: ULID;
  includeGlobal: boolean;
  limit: number;
  type?: LiveEventTypeName;
}

export interface ListLiveEventsResponse {
  ok: true;
  events: LiveEvent[];
  nextCursor: string | null;
  resetRequired?: boolean;
}

export const liveEventRoutes = {
  list: '/api/live-events',
} as const;

const DEFAULT_REPLAY_LIMIT = 100;
const MAX_REPLAY_LIMIT = 500;

export function buildLiveEventFrame<TPayload>(
  event: LiveEvent<TPayload>,
): LiveEventFrame<TPayload> {
  return { type: 'live-event', event };
}

export function isLiveEvent(value: unknown): value is LiveEvent {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    !isLiveEventCursor(value.cursor) ||
    !isLiveEventScope(value.scope) ||
    typeof value.type !== 'string' ||
    !isLiveEventEntity(value.entity) ||
    (value.entityId !== null && typeof value.entityId !== 'string') ||
    (value.version !== null && typeof value.version !== 'number') ||
    typeof value.createdAt !== 'number'
  ) {
    return false;
  }
  if (value.scope === 'global' && value.projectId !== null) return false;
  if (value.scope === 'project' && typeof value.projectId !== 'string') return false;
  return 'payload' in value;
}

export function isLiveEventFrame(value: unknown): value is LiveEventFrame {
  return isRecord(value) && value.type === 'live-event' && isLiveEvent(value.event);
}

export function parseListLiveEventsQuery(input: unknown): ParseResult<ListLiveEventsQuery> {
  const query = isRecord(input) ? input : {};
  const parsed: ListLiveEventsQuery = {
    includeGlobal: query.includeGlobal === '1',
    limit: parseLimit(query.limit),
  };

  if (query.after !== undefined) {
    if (typeof query.after !== 'string' || !isLiveEventCursor(query.after)) {
      return parseErr('after must be a non-negative integer cursor');
    }
    parsed.after = query.after;
  }

  if (query.projectId !== undefined) {
    if (typeof query.projectId !== 'string' || !query.projectId) {
      return parseErr('projectId must be a non-empty string');
    }
    parsed.projectId = query.projectId;
  }

  if (query.type !== undefined) {
    if (!isLiveEventTypeName(query.type)) {
      return parseErr('unsupported live event type');
    }
    parsed.type = query.type;
  }

  return parseOk(parsed);
}

export function isLiveEventCursor(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0;
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_REPLAY_LIMIT;
  const numeric = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(numeric)) return DEFAULT_REPLAY_LIMIT;
  const integer = Math.trunc(numeric);
  if (integer < 1) return 1;
  if (integer > MAX_REPLAY_LIMIT) return MAX_REPLAY_LIMIT;
  return integer;
}

function isLiveEventScope(value: unknown): value is LiveEventScope {
  return value === 'project' || value === 'global';
}

function isLiveEventEntity(value: unknown): value is LiveEventEntity {
  return (
    value === 'project' ||
    value === 'project-claude-md' ||
    value === 'work-item' ||
    value === 'stage' ||
    value === 'field-schema' ||
    value === 'attachment' ||
    value === 'workflow-definition' ||
    value === 'workflow-run' ||
    value === 'workflow-review' ||
    value === 'agent-run' ||
    value === 'mailbox-message' ||
    value === 'pending-interaction' ||
    value === 'session-title' ||
    value === 'pod'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
