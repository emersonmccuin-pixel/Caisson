// Slice 007 — mailbox inbox surface (client + hook + list + action form). The
// first-class UI for user/human decisions. Lists recipients (unread/actioned),
// renders an action form for actionable items (answer / dismiss), and refetches
// on canonical live frames via useMailboxInbox. No route strings live here (the
// client owns them); no raw event parsing in the view (the live helper owns it).

import { useState } from 'react';

import type { WsEnvelope } from '@/features/runtime/ws-types';
import { mailboxApi } from './client';
import { useMailboxInbox } from '@/hooks/use-mailbox-inbox';
import type { MailboxInboxItem } from './types';

export interface MailboxInboxProps {
  /** Project scope, or the global single-user inbox. */
  scope: { projectId: string } | { global: true };
  events: readonly WsEnvelope[];
}

export function MailboxInbox({ scope, events }: MailboxInboxProps) {
  const { items, loading, refetch } = useMailboxInbox(scope, events);

  if (loading && items.length === 0) {
    return <div className="mailbox-inbox mailbox-inbox--empty">Loading inbox…</div>;
  }
  if (items.length === 0) {
    return <div className="mailbox-inbox mailbox-inbox--empty">No messages.</div>;
  }

  return (
    <ul className="mailbox-inbox">
      {items.map((item) => (
        <MailboxInboxRow key={item.recipient.id} item={item} onChanged={refetch} />
      ))}
    </ul>
  );
}

function MailboxInboxRow({ item, onChanged }: { item: MailboxInboxItem; onChanged: () => void }) {
  const { recipient, message } = item;
  const projectId = message.projectId;
  const unread = recipient.readAt === null && recipient.dismissedAt === null;
  const actionable =
    message.interactionId !== null && recipient.actionedAt === null && recipient.dismissedAt === null;
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
    <li className={`mailbox-inbox__row${unread ? ' mailbox-inbox__row--unread' : ''}`}>
      <div className="mailbox-inbox__meta">
        <span className="mailbox-inbox__kind">{message.kind}</span>
        {message.subject && <span className="mailbox-inbox__subject">{message.subject}</span>}
      </div>
      <div className="mailbox-inbox__body">{message.body}</div>

      {actionable && message.interactionId && projectId && (
        <form
          className="mailbox-inbox__action"
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
          />
          <button type="submit" disabled={busy || !answer.trim()}>
            Answer
          </button>
        </form>
      )}

      <div className="mailbox-inbox__controls">
        {projectId && unread && (
          <button type="button" disabled={busy} onClick={() => void act(() => mailboxApi.markRead(projectId, recipient.id))}>
            Mark read
          </button>
        )}
        {projectId && (
          <button type="button" disabled={busy} onClick={() => void act(() => mailboxApi.dismiss(projectId, recipient.id))}>
            Dismiss
          </button>
        )}
      </div>
    </li>
  );
}
