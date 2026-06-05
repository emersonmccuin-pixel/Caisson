import type { JsonlEvent, WsEnvelope } from '@/features/runtime/ws-types';
import type { AgentRunTranscriptStatus } from './types';

export interface AgentJsonlEnvelope extends WsEnvelope {
  type: 'agent-jsonl-event';
  runId: string;
  event: JsonlEvent;
}

export interface AgentTranscriptItem {
  key: string;
  event: JsonlEvent;
}

export type AgentTranscriptLoadStatus = 'loading' | 'ready' | 'error';

export function isAgentJsonlEnvelope(env: WsEnvelope): env is AgentJsonlEnvelope {
  return env.type === 'agent-jsonl-event';
}

export function mergeAgentTranscriptEvents(input: {
  runId: string;
  backfillEvents: JsonlEvent[];
  events: WsEnvelope[];
}): AgentTranscriptItem[] {
  const out: AgentTranscriptItem[] = [];
  const seenStableIds = new Set<string>();
  let ordinal = 0;

  function push(event: JsonlEvent, source: 'backfill' | 'live'): void {
    const stableId = stableTranscriptEventId(event);
    if (stableId) {
      if (seenStableIds.has(stableId)) return;
      seenStableIds.add(stableId);
    }
    out.push({
      key: stableId ?? `transcript:${source}:${ordinal}`,
      event,
    });
    ordinal += 1;
  }

  for (const event of input.backfillEvents) push(event, 'backfill');
  for (const env of input.events) {
    if (!isAgentJsonlEnvelope(env)) continue;
    if (env.runId !== input.runId) continue;
    push(env.event, 'live');
  }
  return out;
}

export function agentTranscriptEmptyMessage(input: {
  loadStatus: AgentTranscriptLoadStatus;
  transcriptStatus: AgentRunTranscriptStatus | null;
  /** S6/FD-18 — the run's lifecycle status. Pre-ready states render an
   *  explicit "Claude is loading…" instead of the ambiguous "no events yet"
   *  ("is it frozen or loading?" must never be a guess). */
  runStatus?: string;
}): string {
  if (input.runStatus === 'queued' || input.runStatus === 'spawning') {
    return 'Claude is loading… the transcript will appear here.';
  }
  if (input.loadStatus === 'loading') return 'Loading transcript...';
  if (input.loadStatus === 'error') return 'Live transcript starts here.';
  if (input.transcriptStatus === 'missing') {
    return 'Provider transcript is missing. Live transcript starts here.';
  }
  if (input.transcriptStatus === 'empty') {
    return 'Transcript file is empty. Live transcript starts here.';
  }
  if (input.runStatus === 'running') {
    return 'Claude is working… output will appear here shortly.';
  }
  return 'No transcript events yet.';
}

function stableTranscriptEventId(event: JsonlEvent): string | null {
  const row = (event as { row?: unknown }).row;
  const uuid = stringField(row, 'uuid') ?? stringField(row, 'id');
  if (uuid) return `${event.kind}:row:${uuid}`;

  if ('toolUseId' in event && typeof event.toolUseId === 'string' && event.toolUseId) {
    return `${event.kind}:tool:${event.toolUseId}`;
  }
  return null;
}

function stringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate ? candidate : null;
}
