// Slice 007 — mailbox inbox surface. Lists recipients grouped by message kind
// and refetches on canonical live frames via useMailboxInbox. No route strings
// live here (the client owns them); no raw event parsing in the view (the live
// helper owns it). M8 slice C grows this into the actionable decision-card
// Human Inbox (approve/reject via the existing decision doors).

import { useEffect, useState } from 'react';

import { isActionableMailboxKind, type MailboxMessageKind } from '@pc/contracts';
import { mailboxApi } from './client';
import { useMailboxInbox } from '@/hooks/use-mailbox-inbox';
import type { MailboxInboxItem } from './types';

export interface MailboxInboxProps {
  /** Project scope, the global single-user inbox, or — M8 (FD-7) — the
   *  cross-project human inbox (the Inbox bell's feed). */
  scope: { projectId: string } | { global: true } | { all: true };
  /** Called whenever the visible item count changes (used by collapse headers). */
  onVisibleCount?: (n: number) => void;
  /** Project id → display name, for the cross-project rows' project chip. */
  projectNames?: Record<string, string>;
}

const KIND_LABELS: Record<MailboxMessageKind, string> = {
  'agent-ask-escalated': 'Agents Waiting on You',
  'agent-question':   'Agent Questions',
  'agent-approval':   'Agent Approvals',
  'workflow-review':  'Workflow Review',
  'verification-review': 'Work to Review',
  'workflow-run-failed': 'Failed Runs',
  'runtime-hook-ask': 'Runtime Asks',
  'agent-terminal':   'Completed Agents',
  'agent-stalled':    'Stalled Agents',
  'external-webhook': 'Webhooks',
  'system-notice':    'System Notices',
};

// Actionable/asks first, then informational — matches catalog UI-home ordering.
// M4b: escalated asks lead — an agent is BLOCKED until the human answers.
const KIND_ORDER: MailboxMessageKind[] = [
  'agent-ask-escalated',
  'agent-question',
  'agent-approval',
  'workflow-review',
  'verification-review',
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

export function MailboxInbox({ scope, onVisibleCount, projectNames }: MailboxInboxProps) {
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
                <MailboxInboxRow
                  key={item.recipient.id}
                  item={item}
                  onChanged={refetch}
                  projectName={
                    (item.message.projectId && projectNames?.[item.message.projectId]) || null
                  }
                />
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

function MailboxInboxRow({
  item,
  onChanged,
  projectName,
}: {
  item: MailboxInboxItem;
  onChanged: () => void;
  projectName?: string | null;
}) {
  const { recipient, message } = item;
  const projectId = message.projectId;
  const unread = recipient.readAt === null && recipient.dismissedAt === null;
  const actionable =
    isActionableMailboxKind(message.kind) &&
    recipient.actionedAt === null &&
    recipient.dismissedAt === null;
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
        {projectName && (
          <span className="shrink-0 rounded bg-accent/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent">
            {projectName}
          </span>
        )}
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

      {/* M8 (FD-7) — the decision card: approve / reject-with-feedback via the
          existing typed doors. The server's decided-elsewhere resolution
          actions this recipient; the live frame refetches the list. */}
      {actionable && projectId && message.kind !== 'agent-ask-escalated' && (
        <DecisionActions item={item} projectId={projectId} onChanged={onChanged} />
      )}

      {/* M4b (FD-8) — the escalated-ask card: answer (option buttons or free
          text) / cancel via the EXISTING pending-ask doors. */}
      {actionable && projectId && message.kind === 'agent-ask-escalated' && (
        <AskEscalatedActions item={item} projectId={projectId} onChanged={onChanged} />
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

/** The payloads slice B writes onto the two decision kinds. Defensive reads —
 *  a malformed payload renders no buttons rather than a broken door. */
function workflowReviewTarget(message: MailboxInboxItem['message']): { runId: string; nodeId: string } | null {
  const p = message.payload as { runId?: unknown; nodeId?: unknown };
  return typeof p.runId === 'string' && typeof p.nodeId === 'string'
    ? { runId: p.runId, nodeId: p.nodeId }
    : null;
}
function verificationTarget(message: MailboxInboxItem['message']): { workItemId: string } | null {
  const p = message.payload as { workItemId?: unknown };
  return typeof p.workItemId === 'string' ? { workItemId: p.workItemId } : null;
}

/** M8 (FD-7) — approve / reject-with-feedback, calling the EXISTING decision
 *  doors (workflow-v2/review · work-items approve/reject). Visible feedback:
 *  buttons flip to a transient ✓ Decided state; errors render inline. */
function DecisionActions({
  item,
  projectId,
  onChanged,
}: {
  item: MailboxInboxItem;
  projectId: string;
  onChanged: () => void;
}) {
  const { message } = item;
  const [showReject, setShowReject] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'rejected' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wfTarget = message.kind === 'workflow-review' ? workflowReviewTarget(message) : null;
  const vrTarget = message.kind === 'verification-review' ? verificationTarget(message) : null;
  if (!wfTarget && !vrTarget) return null;

  // Verification rejects REQUIRE feedback (the agent is woken up with it);
  // workflow-review reject notes flow into the loop's $carry.feedback — same
  // requirement so the kicked-back agent always knows why.
  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      const res = wfTarget
        ? await mailboxApi.decideWorkflowReview(
            projectId,
            wfTarget.runId,
            wfTarget.nodeId,
            decision,
            decision === 'reject' ? feedback.trim() : undefined,
          )
        : decision === 'approve'
          ? await mailboxApi.approveVerification(projectId, vrTarget!.workItemId)
          : await mailboxApi.rejectVerification(projectId, vrTarget!.workItemId, feedback.trim());
      if (!res.ok) throw new Error(res.error ?? 'decision failed');
      setDecided(decision === 'approve' ? 'approved' : 'rejected');
      setTimeout(onChanged, 1200); // let the ✓ register before the row refreshes away
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (decided) {
    return (
      <div
        className={`mb-1.5 px-2 py-1 text-[11px] font-medium ${
          decided === 'approved' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
        }`}
      >
        ✓ {decided === 'approved' ? 'Approved — the run continues.' : 'Sent back with your feedback.'}
      </div>
    );
  }

  return (
    <div className="mb-1.5 flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide('approve')}
          className="bg-primary px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setShowReject((v) => !v)}
          className="border border-destructive/60 bg-card px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          Reject…
        </button>
      </div>
      {showReject && (
        <div className="flex flex-col gap-1">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            placeholder="What should change? (required — the agent gets this feedback)"
            disabled={busy}
            className="border border-border bg-background px-1.5 py-1 text-[11px]"
          />
          <button
            type="button"
            disabled={busy || !feedback.trim()}
            onClick={() => void decide('reject')}
            className="self-start bg-destructive px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
          >
            Send back
          </button>
        </div>
      )}
      {error && <div className="text-[11px] text-destructive">Failed: {error}</div>}
    </div>
  );
}

/** The watchdog payload (slice C). Defensive reads — a malformed payload
 *  renders no buttons rather than a broken door. */
function askEscalatedTarget(
  message: MailboxInboxItem['message'],
): { pendingAskId: string; options: { label: string; value: string }[] } | null {
  const p = message.payload as { pendingAskId?: unknown; options?: unknown };
  if (typeof p.pendingAskId !== 'string') return null;
  const options = Array.isArray(p.options)
    ? p.options.filter(
        (o): o is { label: string; value: string } =>
          !!o && typeof o === 'object' &&
          typeof (o as { label?: unknown }).label === 'string' &&
          typeof (o as { value?: unknown }).value === 'string',
      )
    : [];
  return { pendingAskId: p.pendingAskId, options };
}

/** M4b (FD-8) — answer a blocked agent from the card. Option buttons when the
 *  ask carried options, free text always; Cancel agent drops ask + run. All
 *  through the EXISTING pending-ask doors — the server clears the card
 *  resolve-by-source whichever door decides. */
function AskEscalatedActions({
  item,
  projectId,
  onChanged,
}: {
  item: MailboxInboxItem;
  projectId: string;
  onChanged: () => void;
}) {
  const { message } = item;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'answered' | 'cancelled' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const target = askEscalatedTarget(message);
  if (!target) return null;

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, result: 'answered' | 'cancelled') => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) throw new Error(res.error ?? 'request failed');
      setDone(result);
      setTimeout(onChanged, 1200);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div
        className={`mb-1.5 px-2 py-1 text-[11px] font-medium ${
          done === 'answered' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
        }`}
      >
        ✓ {done === 'answered' ? 'Answer sent — the agent resumes.' : 'Agent cancelled.'}
      </div>
    );
  }

  return (
    <div className="mb-1.5 flex flex-col gap-1.5">
      {target.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {target.options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              disabled={busy}
              onClick={() =>
                void act(
                  () => mailboxApi.answerPendingAsk(projectId, target.pendingAskId, opt.value),
                  'answered',
                )
              }
              className="bg-primary px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Type an answer for the waiting agent…"
          disabled={busy}
          className="border border-border bg-background px-1.5 py-1 text-[11px]"
        />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={busy || !text.trim()}
            onClick={() =>
              void act(
                () => mailboxApi.answerPendingAsk(projectId, target.pendingAskId, text.trim()),
                'answered',
              )
            }
            className="bg-primary px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Send answer
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(() => mailboxApi.cancelPendingAsk(projectId, target.pendingAskId), 'cancelled')
            }
            className="border border-destructive/60 bg-card px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Cancel agent
          </button>
        </div>
      </div>
      {error && <div className="text-[11px] text-destructive">Failed: {error}</div>}
    </div>
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
