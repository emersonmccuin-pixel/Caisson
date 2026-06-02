import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  ChatEvent,
  JsonlEvent,
  SendAckEnvelope,
  SendQueueSnapshotEnvelope,
  UserEvent,
  WsEnvelope,
} from '@/features/runtime/ws-types';

import type { PendingPrompt, PendingPromptStatus, PendingUserEvent } from './types';

const SEND_ACK_TIMEOUT_MS = 3_000;
const TRANSCRIPT_WAITING_TIMEOUT_MS = 15_000;

export function createClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function canonicalUserTextFromEnvelope(env: WsEnvelope): string | null {
  if (env.type === 'jsonl') {
    const ev = env.event as JsonlEvent | undefined;
    return ev?.kind === 'jsonl-user' ? ev.text : null;
  }
  if (env.type === 'event') {
    const ev = env.event as ChatEvent | undefined;
    return ev?.kind === 'user' ? (ev as UserEvent).text : null;
  }
  return null;
}

export function confirmedPendingIds(
  events: WsEnvelope[],
  pendingPrompts: PendingPrompt[],
): Set<string> {
  const confirmed = new Set<string>();
  const pendingIds = new Set(pendingPrompts.map((pending) => pending.id));
  for (let i = 0; i < events.length; i++) {
    const env = events[i]!;
    if (env.type === 'send-queue-snapshot') {
      const snapshot = env as SendQueueSnapshotEnvelope;
      for (const item of snapshot.items) {
        if (item.status === 'observed_in_jsonl' && pendingIds.has(item.clientMessageId)) {
          confirmed.add(item.clientMessageId);
        }
      }
    }
    // id-keyed reconcile (Stage 1 stamp): the canonical jsonl-user envelope
    // carries its originating clientMessageId, so the placeholder is replaced
    // by its real row precisely — no fuzzy text. Additive; the text fallback
    // below stays until Stage 6 for non-queue sends and pre-stamp sessions.
    if (
      env.type === 'jsonl' &&
      typeof env.clientMessageId === 'string' &&
      pendingIds.has(env.clientMessageId)
    ) {
      confirmed.add(env.clientMessageId);
    }
    const text = canonicalUserTextFromEnvelope(env);
    if (text === null) continue;
    const match = pendingPrompts.find((pending) => {
      if (confirmed.has(pending.id) || pending.text !== text) return false;
      const eventFloor = pending.eventFloor <= events.length ? pending.eventFloor : 0;
      return i >= eventFloor;
    });
    if (match) confirmed.add(match.id);
  }
  return confirmed;
}

function sendAckFromEnvelope(env: WsEnvelope): SendAckEnvelope | null {
  if (env.type !== 'send-ack') return null;
  if (typeof env.clientMessageId !== 'string') return null;
  return env as SendAckEnvelope;
}

export function isPendingUserEvent(event: ChatEvent): event is PendingUserEvent {
  if (event.kind !== 'user') return false;
  const candidate = event as Partial<PendingUserEvent>;
  return (
    typeof candidate.text === 'string' &&
    typeof candidate.pendingStatus === 'string' &&
    typeof candidate.pendingClientMessageId === 'string' &&
    typeof candidate.pendingQueued === 'boolean'
  );
}

export function pendingPromptEnvelope(
  projectId: string,
  pending: PendingPrompt,
): WsEnvelope {
  return {
    projectId,
    type: 'event',
    event: {
      kind: 'user',
      text: pending.text,
      ts: new Date(pending.createdAt).toISOString(),
      pendingStatus: pending.status,
      pendingReason: pending.failureReason,
      pendingClientMessageId: pending.id,
      pendingQueued: pending.queued,
    } satisfies PendingUserEvent,
  };
}

export interface PendingPromptInput {
  id: string;
  text: string;
  eventFloor: number;
  expectsAck: boolean;
  queued: boolean;
}

export function usePendingPrompts({
  events,
  currentSessionId,
}: {
  events: WsEnvelope[];
  currentSessionId: string | null;
}) {
  const [pendingPrompts, setPendingPrompts] = useState<PendingPrompt[]>([]);

  useEffect(() => {
    setPendingPrompts((prev) => {
      const confirmed = confirmedPendingIds(events, prev);
      if (confirmed.size === 0) return prev;
      return prev.filter((pending) => !confirmed.has(pending.id));
    });
  }, [events]);

  useEffect(() => {
    setPendingPrompts((prev) => {
      let changed = false;
      const next = prev.map((pending) => {
        if (pending.status === 'failed') return pending;
        const ack = [...events].reverse().map(sendAckFromEnvelope).find((candidate) => {
          return candidate?.clientMessageId === pending.id;
        });
        if (!ack) return pending;
        if (ack.ok) {
          const nextQueued = pending.queued || ack.status === 'queued';
          // Idempotent: if this prompt is already in the acked shape, return it
          // unchanged so we don't hand back a fresh array every render (that
          // turned any upstream `events` churn into a max-update-depth loop).
          if (
            pending.status === 'server-received' &&
            pending.queued === nextQueued &&
            pending.failureReason === undefined
          ) {
            return pending;
          }
          changed = true;
          return {
            ...pending,
            status: 'server-received' as PendingPromptStatus,
            queued: nextQueued,
            failureReason: undefined,
          };
        }
        // Already-failed prompts returned early above, so reaching here is
        // always a real transition into failed.
        changed = true;
        return {
          ...pending,
          status: 'failed' as PendingPromptStatus,
          failureReason: ack.error ?? ack.status,
        };
      });
      return changed ? next : prev;
    });
  }, [events]);

  useEffect(() => {
    if (!currentSessionId) return;
    let snapshot: SendQueueSnapshotEnvelope | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i]!;
      if (env.type !== 'send-queue-snapshot') continue;
      const candidate = env as SendQueueSnapshotEnvelope;
      if (candidate.sessionId !== currentSessionId) continue;
      snapshot = candidate;
      break;
    }
    if (!snapshot) return;

    const byClientMessageId = new Map(
      snapshot.items.map((item) => [item.clientMessageId, item]),
    );
    setPendingPrompts((prev) => {
      let changed = false;
      const next = prev.map((pending) => {
        const item = byClientMessageId.get(pending.id);
        if (!item) return pending;
        if (item.status === 'failed') {
          if (
            pending.status === 'failed' &&
            pending.failureReason === (item.failureReason ?? 'Delivery failed')
          ) {
            return pending;
          }
          changed = true;
          return {
            ...pending,
            status: 'failed' as PendingPromptStatus,
            queued: false,
            failureReason: item.failureReason ?? 'Delivery failed',
          };
        }
        if (
          item.status === 'queued_busy' ||
          item.status === 'queued_spawning' ||
          item.status === 'queued_backlog' ||
          item.status === 'delivering'
        ) {
          if (
            pending.status === 'server-received' &&
            pending.queued &&
            pending.failureReason === undefined
          ) {
            return pending;
          }
          changed = true;
          return {
            ...pending,
            status: 'server-received' as PendingPromptStatus,
            queued: true,
            failureReason: undefined,
          };
        }
        return pending;
      });
      return changed ? next : prev;
    });
  }, [events, currentSessionId]);

  useEffect(() => {
    if (pendingPrompts.length === 0) return;
    const id = setInterval(() => {
      const now = Date.now();
      setPendingPrompts((prev) => {
        if (prev.length === 0) return prev;
        let changed = false;
        const next = prev.map((pending) => {
          if (pending.status === 'failed') return pending;
          const elapsed = now - pending.createdAt;
          if (
            pending.expectsAck &&
            pending.status === 'sending' &&
            elapsed >= SEND_ACK_TIMEOUT_MS
          ) {
            changed = true;
            return { ...pending, status: 'unconfirmed' as PendingPromptStatus };
          }
          if (
            (pending.status === 'sending' ||
              pending.status === 'server-received' ||
              pending.status === 'unconfirmed') &&
            elapsed >= TRANSCRIPT_WAITING_TIMEOUT_MS
          ) {
            changed = true;
            return {
              ...pending,
              status: 'waiting-transcript' as PendingPromptStatus,
            };
          }
          return pending;
        });
        return changed ? next : prev;
      });
    }, 500);
    return () => clearInterval(id);
  }, [pendingPrompts.length]);

  useEffect(() => {
    setPendingPrompts([]);
  }, [currentSessionId]);

  const visiblePendingPrompts = useMemo(() => {
    const confirmed = confirmedPendingIds(events, pendingPrompts);
    return pendingPrompts.filter((pending) => !confirmed.has(pending.id));
  }, [events, pendingPrompts]);

  const recordPendingPrompt = useCallback((pending: PendingPromptInput) => {
    setPendingPrompts((prev) => [
      ...prev,
      {
        ...pending,
        createdAt: Date.now(),
        status: 'sending',
      },
    ]);
  }, []);

  return {
    visiblePendingPrompts,
    recordPendingPrompt,
  };
}
