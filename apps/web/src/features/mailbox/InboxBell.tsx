// M8 (FD-7) — the cross-project Inbox bell. Lives in the app header: a count
// chip for decisions waiting on the human (any project), opening a panel that
// lists every user-inbox card with project chips + decision actions. A review
// needed in project B finds you while you're in project A — the Q12 background
// sockets keep the live store (and so the badge) current for every project.
//
// Explicit close only (no backdrop/Escape dismissal — the reject form hosts
// typed feedback that an accidental dismiss would destroy).

import { useMemo, useState } from 'react';
import { Bell } from 'lucide-react';

import { isActionableMailboxKind } from '@pc/contracts';
import { MailboxInbox, isInboxVisibleKind } from './MailboxInbox';
import { useMailboxInbox } from '@/hooks/use-mailbox-inbox';

export function InboxBell({ projectNames }: { projectNames: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const { items: allItems } = useMailboxInbox({ all: true });

  // Only count what the inbox panel actually SHOWS — otherwise an unread
  // hidden-kind item (e.g. a system-notice / dead-letter) lights the badge with
  // nothing the user can open or dismiss. Same filter the panel uses.
  const items = useMemo(
    () => allItems.filter((i) => isInboxVisibleKind(i.message.kind)),
    [allItems],
  );

  // The badge tracks UNREAD (anything you haven't opened or dismissed). The
  // count of those that also need a decision rides the tooltip.
  const unread = useMemo(
    () =>
      items.filter(
        (i) => i.recipient.readAt === null && i.recipient.dismissedAt === null,
      ).length,
    [items],
  );
  const actionable = useMemo(
    () =>
      items.filter(
        (i) =>
          isActionableMailboxKind(i.message.kind) &&
          i.recipient.actionedAt === null &&
          i.recipient.dismissedAt === null,
      ).length,
    [items],
  );

  const title =
    unread > 0
      ? `${String(unread)} unread message${unread === 1 ? '' : 's'}` +
        (actionable > 0 ? ` · ${String(actionable)} need a decision` : '')
      : 'Inbox';

  return (
    <div className="relative flex h-full items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-label={unread > 0 ? `Inbox, ${String(unread)} unread` : 'Inbox'}
        aria-expanded={open}
        className={`relative flex h-full items-center px-2 hover:bg-muted ${
          open ? 'bg-muted text-foreground' : 'text-muted-foreground'
        }`}
      >
        <Bell className="h-3.5 w-3.5" />
        {unread > 0 && (
          <span className="absolute right-0 top-1 min-w-[14px] rounded-full bg-destructive px-1 text-center text-[9px] font-bold leading-[14px] text-destructive-foreground">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 flex max-h-[70vh] w-[380px] flex-col border border-border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Inbox — all projects
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close inbox"
              className="px-1 text-[12px] text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
          <div className="overflow-y-auto p-3">
            <MailboxInbox scope={{ all: true }} projectNames={projectNames} />
          </div>
        </div>
      )}
    </div>
  );
}
