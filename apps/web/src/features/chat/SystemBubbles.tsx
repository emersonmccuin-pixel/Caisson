import { useState } from 'react';

import type { SystemEvent } from '@/features/runtime/ws-types';

export function CompactBoundaryRule({
  event,
}: {
  event: {
    trigger?: string | null;
    preTokens?: number | null;
    messagesSummarized?: number | null;
  };
}) {
  const trigger = event.trigger ? ` ${event.trigger}` : '';
  const tokens =
    typeof event.preTokens === 'number'
      ? ` · ${event.preTokens.toLocaleString()} tokens compacted`
      : '';
  const msgs =
    typeof event.messagesSummarized === 'number'
      ? ` · ${event.messagesSummarized} messages`
      : '';
  return (
    <div className="self-center flex w-full items-center gap-2 px-2 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
      <span className="h-px flex-1 border-t border-dashed border-border" />
      <span className="px-1">compacted{trigger}{tokens}{msgs}</span>
      <span className="h-px flex-1 border-t border-dashed border-border" />
    </div>
  );
}

export function MicrocompactDivider({
  event,
}: {
  event: { tokensSaved?: number | null; preTokens?: number | null };
}) {
  const saved =
    typeof event.tokensSaved === 'number'
      ? `· ${event.tokensSaved.toLocaleString()} tokens freed`
      : '';
  return (
    <div className="self-center flex w-full items-center gap-2 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
      <span className="h-px flex-1 bg-border" />
      <span>· microcompact {saved} ·</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

const SPEED_TONE: Record<string, string> = {
  slow: 'border-amber-600/60 bg-amber-950/30 text-amber-200',
  fast: 'border-emerald-600/60 bg-emerald-950/30 text-emerald-200',
};

export function NotificationRow({
  event,
}: {
  event: { message: string; title?: string | null };
}) {
  return (
    <div className="self-start flex max-w-[90%] items-center gap-2 border-l-2 border-info bg-info/5 px-2 py-1 text-xs text-foreground">
      <span className="font-mono text-[10px] uppercase tracking-wider text-info">
        {event.title ?? 'Claude'}
      </span>
      <span className="min-w-0 flex-1 truncate">{event.message || '(no message)'}</span>
    </div>
  );
}

export function TurnFooterChips({
  event,
}: {
  event: { speed?: string | null; cacheMissReason?: string | null; model?: string | null };
}) {
  const hasSpeed = event.speed && event.speed !== 'standard';
  const hasMiss = !!event.cacheMissReason;
  if (!hasSpeed && !hasMiss) return null;
  return (
    <div className="self-start flex flex-wrap items-center gap-1.5 px-1 text-[10px]">
      {hasSpeed && (
        <span
          className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono uppercase tracking-wider ${
            SPEED_TONE[event.speed!] ?? 'border-border bg-muted text-muted-foreground'
          }`}
          title={event.model ? `${event.speed} · ${event.model}` : event.speed!}
        >
          {event.speed}
        </span>
      )}
      {hasMiss && (
        <span
          className="inline-flex items-center gap-1 border border-amber-600/60 bg-amber-950/30 px-1.5 py-0.5 font-mono uppercase tracking-wider text-amber-200"
          title={`Prompt cache miss · ${event.cacheMissReason}`}
        >
          cache miss · {event.cacheMissReason}
        </span>
      )}
    </div>
  );
}

export function SystemBubble({ event }: { event: SystemEvent }) {
  if (event.level === 'error') return <SystemErrorBubble event={event} />;
  return <SystemFooter event={event} />;
}

export function SystemErrorBubble({ event }: { event: SystemEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className="bg-destructive px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-destructive-foreground">
          {event.subtype.replace(/_/g, ' ')}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {event.level}
        </span>
        {event.ts && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {new Date(event.ts).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div className="whitespace-pre-wrap break-words text-sm text-foreground">
        {event.message}
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-1.5 text-[10px] uppercase tracking-wider text-muted-foreground underline-offset-2 hover:underline"
      >
        {open ? 'Hide details' : 'Show details'}
      </button>
      {open && <SystemRawDump raw={event.raw} />}
    </div>
  );
}

// Section 32.5 — routine system events render as centered whisper text
// (dotted border, smaller type, muted) so they fade into the chat scroll
// instead of competing with speaker turns. Click to expand details inline;
// errors still get the loud red SystemErrorBubble treatment.
export function SystemFooter({ event }: { event: SystemEvent }) {
  const [open, setOpen] = useState(false);
  const previewRaw = event.message.startsWith(`[${event.subtype}]`)
    ? event.message.slice(`[${event.subtype}]`.length).trim()
    : event.message;
  const preview = previewRaw.split('\n')[0] ?? '';
  const hasMore = previewRaw !== preview || event.raw !== undefined;
  return (
    <div className="self-center max-w-[80%] text-[10px] text-muted-foreground/80">
      <button
        type="button"
        onClick={() => hasMore && setOpen((v) => !v)}
        className={`flex w-full items-center justify-center gap-2 border border-dotted border-border/70 px-3 py-0.5 text-center uppercase tracking-[0.06em] ${
          hasMore ? 'hover:border-border hover:text-foreground/80' : 'cursor-default'
        }`}
      >
        <span className="text-muted-foreground/70">
          {event.subtype.replace(/_/g, ' ')}
        </span>
        {preview && (
          <>
            <span className="text-[var(--fg-dim)]">·</span>
            <span className="min-w-0 truncate normal-case tracking-normal italic text-muted-foreground/80">
              {preview}
            </span>
          </>
        )}
        {hasMore && (
          <>
            <span className="text-[var(--fg-dim)]">·</span>
            <span className="shrink-0 text-[var(--fg-dim)] underline-offset-2 hover:underline">
              {open ? 'hide' : 'details'}
            </span>
          </>
        )}
      </button>
      {open && (
        <div className="mt-1 self-center border-l-2 border-border/50 pl-3 text-left normal-case tracking-normal">
          {previewRaw !== preview && (
            <div className="mb-1.5 whitespace-pre-wrap break-words text-foreground/90">
              {previewRaw}
            </div>
          )}
          <SystemRawDump raw={event.raw} />
        </div>
      )}
    </div>
  );
}

/** FD-3/FD-6 — a mailbox-injected system message (a `[pc:…]`-marked user turn:
 *  agent finished, workflow review, run failed, …). Rendered as a distinct
 *  system card — never as a human bubble — with the marker stripped, a kind
 *  chip, and a collapsed body (first line shown; click to expand). Visible by
 *  default; the chat-footer "System" toggle hides them. */
export function SystemTurnCard({
  kind,
  text,
  ts,
}: {
  kind: string;
  text: string;
  ts?: string;
}) {
  const [open, setOpen] = useState(false);
  const firstLine = text.split('\n')[0] ?? '';
  const hasMore = text.trim() !== firstLine.trim();
  const time = ts
    ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;
  return (
    <div className="self-start w-full max-w-[92%] border-l-2 border-info bg-info/5 px-3 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="bg-info/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-info">
          ⚙ system
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {kind.replace(/-/g, ' ')}
        </span>
        {time && (
          <span className="ml-auto text-[10px] text-muted-foreground">{time}</span>
        )}
      </div>
      <div className="mt-1 text-foreground/90">
        {open ? (
          <div className="whitespace-pre-wrap break-words">{text}</div>
        ) : (
          <div className="truncate">{firstLine || '(no message)'}</div>
        )}
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground underline-offset-2 hover:underline"
        >
          {open ? 'Collapse' : 'Show full message'}
        </button>
      )}
    </div>
  );
}

export function SystemRawDump({ raw }: { raw: unknown }) {
  return (
    <pre className="mt-1.5 max-h-64 overflow-auto border border-border bg-background p-2 font-mono text-[10px] leading-snug">
      {(() => {
        try {
          return JSON.stringify(raw, null, 2);
        } catch {
          return String(raw);
        }
      })()}
    </pre>
  );
}
