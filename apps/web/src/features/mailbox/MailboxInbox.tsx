// Slice 007 — mailbox inbox surface. Lists recipients grouped by message kind,
// renders action forms for actionable items (answer / dismiss), and refetches
// on canonical live frames via useMailboxInbox. No route strings live here (the
// client owns them); no raw event parsing in the view (the live helper owns it).

import { useEffect, useState } from 'react';

import type { MailboxMessageKind } from '@pc/contracts';
import { mailboxApi } from './client';
import { useMailboxInbox } from '@/hooks/use-mailbox-inbox';
import type { MailboxInboxItem } from './types';

export interface MailboxInboxProps {
  /** Project scope, or the global single-user inbox. */
  scope: { projectId: string } | { global: true };
  /** Called whenever the visible item count changes (used by collapse headers). */
  onVisibleCount?: (n: number) => void;
}

const KIND_LABELS: Record<MailboxMessageKind, string> = {
  'agent-question':   'Agent Questions',
  'agent-approval':   'Agent Approvals',
  'workflow-review':  'Workflow Review',
  'workflow-run-failed': 'Failed Runs',
  'runtime-hook-ask': 'Runtime Asks',
  'agent-terminal':   'Completed Agents',
  'agent-stalled':    'Stalled Agents',
  'external-webhook': 'Webhooks',
  'system-notice':    'System Notices',
};

// Actionable/asks first, then informational — matches catalog UI-home ordering.
const KIND_ORDER: MailboxMessageKind[] = [
  'agent-question',
  'agent-approval',
  'workflow-review',
  'workflow-run-failed',
  'runtime-hook-ask',
  'agent-terminal',
  'agent-stalled',
  'external-webhook',
  'system-notice',
];

// Kinds that are never surfaced in the inbox — filtered out unconditionally, no
// UI control. Only Agent Questions and Workflow Review remain visible.
// agent-stalled is the orchestrator's to handle (the human already sees the
// run's `stalled` badge — rung 1 of the same ladder).
const HIDDEN_KINDS: ReadonlySet<MailboxMessageKind> = new Set([
  'agent-approval',
  'runtime-hook-ask',
  'agent-terminal',
  'agent-stalled',
  'external-webhook',
  'system-notice',
]);

export function MailboxInbox({ scope, onVisibleCount }: MailboxInboxProps) {
  const { items, loading, refetch } = useMailboxInbox(scope);

  // Drop the never-shown kinds before anything counts, groups, or renders.
  const visibleItems = items.filter((item) => !HIDDEN_KINDS.has(item.message.kind));

  useEffect(() => {
    onVisibleCount?.(visibleItems.length);
  }, [visibleItems.length, onVisibleCount]);

  if (loading && visibleItems.length === 0) {
    return (
      <div className="py-1 text-[11px] italic text-muted-foreground/70">Loading inbox…</div>
    );
  }
  if (visibleItems.length === 0) {
    return (
      <div className="py-1 text-[11px] italic text-muted-foreground/70">No messages.</div>
    );
  }

  // Group the visible items by kind.
  const grouped = new Map<MailboxMessageKind, MailboxInboxItem[]>();
  for (const item of visibleItems) {
    const k = item.message.kind;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(item);
  }

  return (
    <div className="space-y-3">
      {KIND_ORDER.map((kind) => {
        const group = grouped.get(kind);
        if (!group || group.length === 0) return null;
        return (
          <div key={kind}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {KIND_LABELS[kind]}
              </span>
              <span className="bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                {group.length}
              </span>
            </div>
            <ul className="space-y-1.5">
              {group.map((item) => (
                <MailboxInboxRow key={item.recipient.id} item={item} onChanged={refetch} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Single-line title for the collapsed card: subject, else the first non-empty
 *  body line that isn't a machine marker, else a label derived from any
 *  `[pc:agent-event kind=… ]` marker, else the kind label. Keeps long bodies —
 *  and raw envelope markers — out of the list. */
function rowTitle(message: MailboxInboxItem['message']): string {
  const subject = message.subject?.trim();
  if (subject) return subject;
  const lines = message.body.split('\n').map((l) => l.trim()).filter(Boolean);
  // Agent-terminal bodies are a machine envelope ([pc:agent-event …] then
  // [runId: …]) with no human text — derive a label from the event kind rather
  // than echoing a marker line.
  if (lines[0]?.startsWith('[pc:agent-event')) {
    const markerKind = lines[0].match(/kind=([a-z-]+)/)?.[1];
    if (markerKind === 'agent-completed') return 'Agent completed';
    if (markerKind === 'agent-failed') return 'Agent failed';
    if (markerKind === 'agent-queued-started') return 'Agent started';
    return KIND_LABELS[message.kind];
  }
  // Otherwise the first non-empty, non-bracket-marker line is the human title.
  const humanLine = lines.find((l) => !l.startsWith('['));
  if (humanLine) return humanLine;
  return KIND_LABELS[message.kind];
}

function MailboxInboxRow({ item, onChanged }: { item: MailboxInboxItem; onChanged: () => void }) {
  const { recipient, message } = item;
  const projectId = message.projectId;
  const unread = recipient.readAt === null && recipient.dismissedAt === null;
  const actionable =
    message.interactionId !== null &&
    recipient.actionedAt === null &&
    recipient.dismissedAt === null;
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  // Collapsed by default — the card shows a title + type; the full body lives
  // behind a click so completed-agent dumps don't flood the rail.
  const [expanded, setExpanded] = useState(false);

  // Project-scoped actions need a projectId; the global user-inbox messages are
  // project-less, so action/answer routes are unavailable for them (read/dismiss
  // still work through whatever project context the host wires — guarded here).
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={[
        'rounded border border-border text-[12px]',
        unread ? 'bg-primary/5' : 'bg-card',
      ].join(' ')}
    >
      {/* Collapsed header — click to expand the body + actions */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 p-2 text-left"
      >
        <span className="text-[9px] text-muted-foreground/60">{expanded ? '▾' : '▸'}</span>
        {unread && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="unread" />}
        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          {message.kind}
        </span>
        <span className={`min-w-0 flex-1 truncate${unread ? ' font-medium text-foreground' : ' text-foreground/80'}`}>
          {rowTitle(message)}
        </span>
        {actionable && (
          <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">
            Action
          </span>
        )}
        <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground/60">
          {formatRelativeTime(message.createdAt)}
        </span>
      </button>

      {!expanded ? null : (
      <div className="px-2 pb-2">
      {/* Body — capped so even an expanded completion can't run away */}
      <div className="mb-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/80">
        {message.body}
      </div>

      {/* Answer form */}
      {actionable && message.interactionId && projectId && (
        <form
          className="mb-1.5 flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!answer.trim()) return;
            void act(async () => {
              await mailboxApi.answerInteraction(projectId, message.interactionId!, answer.trim());
              await mailboxApi.markActioned(projectId, recipient.id);
            });
          }}
        >
          <input
            type="text"
            value={answer}
            placeholder="Your answer…"
            onChange={(e) => setAnswer(e.target.value)}
            disabled={busy}
            className="min-w-0 flex-1 border border-border bg-background px-1.5 py-0.5 text-[11px]"
          />
          <button
            type="submit"
            disabled={busy || !answer.trim()}
            className="shrink-0 border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            Answer
          </button>
        </form>
      )}

      {/* Action controls */}
      <div className="flex items-center gap-1">
        {projectId && unread && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => mailboxApi.markRead(projectId, recipient.id))}
            className="border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            Mark read
          </button>
        )}
        {projectId && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => mailboxApi.dismiss(projectId, recipient.id))}
            className="border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            Dismiss
          </button>
        )}
      </div>
      </div>
      )}
    </li>
  );
}

function formatRelativeTime(epochMs: number): string {
  const diffSec = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}
