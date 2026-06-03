// Shared JSONL transcript row renderer. Used by AgentTranscriptModal (slide-in
// panel) and AgentDispatchGroupBubble (inline card transcript). Extracted so
// both surfaces render JSONL identically without duplicating parsing logic.

import type { JsonlEvent } from '@/features/runtime/ws-types';

export function TranscriptRow({ event }: { event: JsonlEvent }) {
  switch (event.kind) {
    case 'jsonl-user':
      return (
        <Row label="user" tone="user">
          <div className="whitespace-pre-wrap text-foreground">{event.text}</div>
        </Row>
      );
    case 'jsonl-turn-end':
      return (
        <Row label="assistant" tone="assistant">
          <div className="whitespace-pre-wrap text-foreground">{event.text}</div>
          {event.stopReason && event.stopReason !== 'end_turn' && (
            <div className="mt-1 font-mono text-[10px] text-muted-foreground">
              stop: {event.stopReason}
            </div>
          )}
        </Row>
      );
    case 'jsonl-tool-call':
      return (
        <Row label={`tool: ${event.name}`} tone="tool">
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
            {truncate(safeJson(event.input), 800)}
          </pre>
        </Row>
      );
    case 'jsonl-tool-result':
      return (
        <Row
          label={event.isError ? 'tool result · error' : 'tool result'}
          tone={event.isError ? 'error' : 'tool'}
        >
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
            {truncate(safeJson(event.result), 800)}
          </pre>
        </Row>
      );
    case 'jsonl-system':
      return (
        <Row
          label={`system · ${event.subtype}`}
          tone={event.level === 'error' ? 'error' : 'system'}
        >
          <div className="whitespace-pre-wrap text-foreground">{event.message}</div>
        </Row>
      );
    case 'jsonl-usage':
      return (
        <Row label="usage" tone="muted">
          <div className="font-mono text-[10px] text-muted-foreground">
            in {event.inputTokens} · out {event.outputTokens} · cache-r{' '}
            {event.cacheReadTokens} · cache-w {event.cacheCreationTokens}
            {event.model ? ` · ${event.model}` : ''}
          </div>
        </Row>
      );
    case 'jsonl-queue-enqueue':
    case 'jsonl-queue-dequeue':
    case 'jsonl-sidechain':
      return (
        <Row label={event.kind.replace(/^jsonl-/, '')} tone="muted">
          <div className="font-mono text-[10px] text-muted-foreground">—</div>
        </Row>
      );
    default:
      return (
        <Row label="event" tone="muted">
          <pre className="whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
            {truncate(safeJson(event), 400)}
          </pre>
        </Row>
      );
  }
}

export type RowTone = 'user' | 'assistant' | 'tool' | 'system' | 'error' | 'muted';

export function Row({
  label,
  tone,
  children,
}: {
  label: string;
  tone: RowTone;
  children: React.ReactNode;
}) {
  const toneClasses: Record<RowTone, string> = {
    user: 'border-l-primary/60',
    assistant: 'border-l-foreground/30',
    tool: 'border-l-muted-foreground/40',
    system: 'border-l-warning/60',
    error: 'border-l-destructive/70',
    muted: 'border-l-border',
  };
  return (
    <li className={`border-l-2 ${toneClasses[tone]} pl-2`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-xs">{children}</div>
    </li>
  );
}

export function safeJson(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (${s.length - max} more chars)`;
}
