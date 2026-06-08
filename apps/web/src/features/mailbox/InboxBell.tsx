// M8 (FD-7) — the cross-project Inbox bell. Lives in the app header: a count
// chip for decisions waiting on the human (any project), opening a panel that
// lists every user-inbox card with project chips + decision actions. A review
// needed in project B finds you while you're in project A — the Q12 background
// sockets keep the live store (and so the badge) current for every project.
//
// Explicit close only (no backdrop/Escape dismissal — the reject form hosts
// typed feedback that an accidental dismiss would destroy).
//
// pc-pty-chat-316: the server filters every inbox route to user-inbox recipients;
// allItems is already the correct set. No client-side kind re-classification.

import { useMemo, useState } from 'react';
import { Bell, Download } from 'lucide-react';

import { isActionableMailboxKind } from '@pc/contracts';
import { MailboxInbox } from './MailboxInbox';
import { UpdateBellCard, isUpdatePending } from './UpdateBellCard';
import { useMailboxInbox } from '@/hooks/use-mailbox-inbox';
import { useDesktopUpdates } from '@/hooks/use-desktop-updates';

export function InboxBell({ projectNames }: { projectNames: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const { items: allItems } = useMailboxInbox({ all: true });

  // A pending desktop update rides the same bell — its own green dot (distinct
  // from the red unread count) and a pinned card in the panel. Inert in the
  // browser / dev-run (state stays null), so this adds nothing there.
  const updates = useDesktopUpdates();
  const updatePending = isUpdatePending(updates);

  // The server pre-filters to user-inbox recipients — allItems is already the
  // correct set for the human inbox. Badge counts are derived directly.

  // The badge tracks UNREAD (anything you haven't opened or dismissed).
  const unread = useMemo(
    () =>
      allItems.filter(
        (i) => i.recipient.readAt === null && i.recipient.dismissedAt === null,
      ).length,
    [allItems],
  );

  // The tooltip shows how many items require an explicit decision.
  const actionable = useMemo(
    () =>
      allItems.filter(
        (i) =>
          isActionableMailboxKind(i.message.kind) &&
          i.recipient.actionedAt === null &&
          i.recipient.dismissedAt === null,
      ).length,
    [allItems],
  );

  const title =
    [
      unread > 0
        ? `${String(unread)} unread message${unread === 1 ? '' : 's'}` +
          (actionable > 0 ? ` · ${String(actionable)} need a decision` : '')
        : null,
      updatePending ? 'Caisson update available' : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'Inbox';

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
        {updatePending && (
          <span
            className="absolute bottom-1 right-0 flex h-[14px] w-[14px] items-center justify-center rounded-full bg-primary text-primary-foreground"
            title="Caisson update available"
          >
            <Download className="h-2.5 w-2.5" />
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
            {updatePending && <UpdateBellCard updates={updates} />}
            <MailboxInbox scope={{ all: true }} projectNames={projectNames} />
          </div>
        </div>
      )}
    </div>
  );
}
