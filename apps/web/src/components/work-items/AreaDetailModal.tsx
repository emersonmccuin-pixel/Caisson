// FD-19 — Area detail modal. Card-click target on the Areas tab. Shows the
// Area's name, summary, and all work items filed in it (including done /
// cancelled — with status labels). Edit button opens AreaEditModal over this
// modal. Work-item rows open via the shell-level useChatWorkItemModal store
// so no local modal mount is needed. Explicit close only — no backdrop-click /
// Escape (house rule; modals host hard-to-redo work).

import { useState } from 'react';

import type { Area } from '@/features/areas/client';
import type { WorkItem } from '@/features/work-items/client';
import { WORK_ITEM_STATUS_DOT_CLASS, WORK_ITEM_STATUS_LABEL } from '@/features/work-items/status';
import { useChatWorkItemModal } from '@/store/chat-work-item-modal';
import { AreaEditModal } from './AreaEditModal';

interface Props {
  projectId: string;
  area: Area;
  /** All work items in the project — filtered internally to area members. */
  workItems: WorkItem[];
  openCount: number;
  doneCount: number;
  onClose: () => void;
  /** Fired after any successful mutation (save / delete) in the edit modal. */
  onChanged: () => void;
}

export function AreaDetailModal({
  projectId,
  area,
  workItems,
  openCount,
  doneCount,
  onClose,
  onChanged,
}: Props) {
  const [editing, setEditing] = useState(false);
  const openWorkItem = useChatWorkItemModal((s) => s.open);

  const members = workItems.filter((wi) => wi.areaId === area.id);

  function handleEditChanged() {
    onChanged();
    setEditing(false);
    onClose(); // area may no longer exist (delete) — always close detail
  }

  return (
    <>
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/40">
        <div className="flex max-h-[85vh] w-full max-w-xl flex-col border border-border bg-card text-foreground">
          <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-base font-semibold">{area.name}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {openCount} open · {doneCount} done
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="border border-border/60 px-2.5 py-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground hover:border-border hover:text-foreground"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                ×
              </button>
            </div>
          </header>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
            {area.summary ? (
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
                {area.summary}
              </p>
            ) : (
              <p className="text-[13px] italic text-[var(--fg-dim)]">No description.</p>
            )}

            <div>
              <div className="mb-2 text-[10px] uppercase tracking-[0.08em] text-[var(--fg-dim)]">
                Members · {members.length}
              </div>

              {members.length === 0 ? (
                <div className="border border-dashed border-border/30 px-3 py-5 text-center text-[12px] text-muted-foreground">
                  No work items in this Area yet.
                </div>
              ) : (
                <div className="flex flex-col border border-border/40">
                  {members.map((wi) => (
                    <button
                      key={wi.id}
                      type="button"
                      onClick={() => openWorkItem(wi.id)}
                      className="flex items-center gap-2 border-b border-border/30 px-3 py-2 text-left last:border-b-0 hover:bg-primary/[0.04]"
                    >
                      <span
                        className={`inline-block h-[7px] w-[7px] shrink-0 ${WORK_ITEM_STATUS_DOT_CLASS[wi.status]}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                        {wi.title}
                      </span>
                      {wi.callsign && (
                        <span className="shrink-0 text-[10px] text-[var(--fg-dim)]">
                          {wi.callsign}
                        </span>
                      )}
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {WORK_ITEM_STATUS_LABEL[wi.status]}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <footer className="flex items-center justify-end border-t border-border px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </footer>
        </div>
      </div>

      {editing && (
        <AreaEditModal
          projectId={projectId}
          area={area}
          openCount={openCount}
          doneCount={doneCount}
          onClose={() => setEditing(false)}
          onChanged={handleEditChanged}
        />
      )}
    </>
  );
}
