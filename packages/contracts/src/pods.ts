// Slice 015b-tail — canonical live-event contract for pod (agent-definition)
// changes. Pods are the Agents-tab roster: DB-owned facts in the `agents`
// table. A pod mutation (create/update/delete/clone/promote/reset, plus nested
// knowledge/secret/mcp edits) writes a durable `pod.changed` outbox row in-txn;
// the relay fans the canonical frame and the roster refetches.
//
// Scope: a global pod emits a GLOBAL frame (reaches every project socket so the
// stock-globals row in every Agents tab refreshes); a project pod emits a
// PROJECT frame for its owning project. The payload is intentionally minimal —
// the consumer refetches the list rather than applying the snapshot inline — so
// this contract stays decoupled from the domain `PodAgentRow` shape.

import {
  isLiveEvent,
  isLiveEventFrame,
  type LiveEvent,
  type LiveEventFrame,
} from './live-events.ts';
import { type ULID } from './shared.ts';

export type PodChangedKind = 'created' | 'updated' | 'deleted';

export const POD_CHANGED_KINDS: readonly PodChangedKind[] = ['created', 'updated', 'deleted'];

export interface PodChangedLivePayload {
  change: PodChangedKind;
  podId: ULID;
  /** Best-effort name for logging/UX; the roster refetches for the truth. */
  name?: string;
}

export type PodChangedLiveEvent = LiveEvent<PodChangedLivePayload> & {
  type: 'pod.changed';
  entity: 'pod';
};

export type PodChangedLiveEventFrame = LiveEventFrame<PodChangedLivePayload> & {
  event: PodChangedLiveEvent;
};

export function isPodChangedKind(value: unknown): value is PodChangedKind {
  return typeof value === 'string' && (POD_CHANGED_KINDS as readonly string[]).includes(value);
}

export function isPodChangedLivePayload(value: unknown): value is PodChangedLivePayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!isPodChangedKind(v.change)) return false;
  if (typeof v.podId !== 'string' || !v.podId) return false;
  if (v.name !== undefined && typeof v.name !== 'string') return false;
  return true;
}

export function isPodChangedLiveEvent(value: unknown): value is PodChangedLiveEvent {
  if (!isLiveEvent(value)) return false;
  if (value.type !== 'pod.changed') return false;
  if (value.entity !== 'pod') return false;
  return isPodChangedLivePayload(value.payload);
}

export function isPodChangedLiveEventFrame(value: unknown): value is PodChangedLiveEventFrame {
  return isLiveEventFrame(value) && isPodChangedLiveEvent(value.event);
}
