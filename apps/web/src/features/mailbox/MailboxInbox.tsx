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
  'runtime-hook-ask': 'Runtime Asks',
  'agent-terminal':   'Completed Agents',
  'external-webhook': 'Webhooks',
  'system-notice':    'System Notices',
};

// Actionable/asks first, then informational — matches catalog UI-home ordering.
const KIND_ORDER: MailboxMessageKind[] = [
  'agent-question',
  'agent-approval',
  'workflow-review',
  'runtime-hook-ask',
  'agent-terminal',
  'external-webhook',
  'system-notice',
];

export function MailboxInbox({ scope, onVisibleCount }: MailboxInboxProps) {
  const { items, loading, refetch } = useMailboxInbox(scope);

  useEffect(() => {
    onVisibleCount?.(items.length);
  }, [items.length, onVisibleCount]);

  if (loading && items.length === 0) {
    return (
      <div className="py-1 text-[11px] italic text-muted-foreground/70">Loading inbox…</div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="py-1 text-[11px] italic text-muted-foreground/70">No messages.</div>
    );
  }

  // Group by kind.
  const grouped = new Map<MailboxMessageKind, MailboxInboxItem[]>();
  for (const item of items) {
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
        'rounded border border-border p-2 text-[12px]',
        unread ? 'bg-primary/5' : 'bg-card',
      ].join(' ')}
    >
      {/* Meta: kind badge + subject */}
      <div className="mb-1.5 flex items-baseline gap-1.5">
        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          {message.kind}
        </span>
        {message.subject && (
          <span className={`truncate${unread ? ' font-medium text-foreground' : ' text-foreground/80'}`}>
            {message.subject}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="mb-2 text-[11px] leading-relaxed text-foreground/80">{message.body}</div>

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
    </li>
  );
}
