// Quick Tasks panel — pinned at the bottom of the Command right rail.
// Lists Command project's intake-stage work items; inline title + Enter to
// capture; checkbox to mark done (moves to the done stage). Collapse state
// persists in localStorage. Responds to the command-task-focus signal
// (fired by the "+Task" button in the header) to auto-expand + focus input.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Project } from '@/features/projects/client';
import type { WorkItem } from '@/features/work-items/types';
import { workItemsApi } from '@/features/work-items/client';
import { useGlobalQuickAdd } from '@/store/global-quick-add';
import { useCommandTaskFocus } from '@/store/command-task-focus';

const STORAGE_KEY = 'caisson.quick-tasks-panel.collapsed';

interface Props {
  commandProject: Project;
}

export function QuickTasksPanel({ commandProject }: Props) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      // Default collapsed; only expand if explicitly stored as 'false'.
      return localStorage.getItem(STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  const [items, setItems] = useState<WorkItem[]>([]);
  const [inputTitle, setInputTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const openGlobalQuickAdd = useGlobalQuickAdd((s) => s.open);
  const lastFiredAt = useCommandTaskFocus((s) => s.lastFiredAt);
  // Track the last handled signal so re-renders don't re-trigger focus.
  const prevLastFiredAtRef = useRef(0);

  const intakeId = useMemo(
    () =>
      commandProject.stages.find((s) => s.isNew)?.id ??
      commandProject.stages[0]?.id ??
      'draft',
    [commandProject.stages],
  );

  const doneId = useMemo(
    () =>
      commandProject.stages.find((s) => s.isDone)?.id ??
      commandProject.stages[commandProject.stages.length - 1]?.id ??
      'done',
    [commandProject.stages],
  );

  const loadItems = useCallback(async () => {
    try {
      const all = await workItemsApi.workItems(commandProject.id);
      setItems(
        all.filter((wi) => wi.stageId === intakeId && wi.deletedAt == null),
      );
    } catch {
      // best-effort — panel still renders, just with stale data
    }
  }, [commandProject.id, intakeId]);

  // Initial load and whenever the project or intake stage changes.
  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  // Refetch when the section is expanded (keeps items fresh after e.g. a
  // GlobalQuickAdd capture that happened while the section was collapsed).
  useEffect(() => {
    if (!collapsed) void loadItems();
  }, [collapsed, loadItems]);

  // Respond to the "+Task" focus signal from App.tsx: expand + focus input.
  useEffect(() => {
    if (lastFiredAt > prevLastFiredAtRef.current) {
      prevLastFiredAtRef.current = lastFiredAt;
      setCollapsed(false);
      try {
        localStorage.setItem(STORAGE_KEY, 'false');
      } catch {
        /* storage unavailable */
      }
      // Small delay so the input is in the DOM before focus.
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [lastFiredAt]);

  function toggleCollapse() {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }

  async function handleCreate() {
    const title = inputTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await workItemsApi.createWorkItem(commandProject.id, title, intakeId);
      setInputTitle('');
      await loadItems();
    } catch {
      // best-effort
    } finally {
      setBusy(false);
    }
  }

  async function handleComplete(item: WorkItem) {
    if (item.stageId === doneId) return;
    // Optimistic: remove from list immediately.
    setItems((prev) => prev.filter((wi) => wi.id !== item.id));
    try {
      await workItemsApi.moveWorkItem(commandProject.id, item.id, item.version, {
        stageId: doneId,
      });
    } catch {
      // Revert on error.
      await loadItems();
    }
  }

  return (
    <section className="shrink-0 border-t border-border">
      {/* Section header — click to expand/collapse */}
      <div className="flex items-center px-3 py-1.5">
        <button
          type="button"
          onClick={toggleCollapse}
          className="flex flex-1 items-center gap-1.5 text-left"
        >
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Quick Tasks
          </span>
          <span className="bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
            {items.length}
          </span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {collapsed ? '▾' : '▴'}
          </span>
        </button>
        {/* Secondary option: full capture modal (title + note + project chooser) */}
        <button
          type="button"
          onClick={() => openGlobalQuickAdd()}
          title="Capture with note…"
          className="ml-2 shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
        >
          + with note
        </button>
      </div>

      {!collapsed && (
        <div className="px-3 pb-3">
          {/* Inline add — Enter to capture */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
            className="mb-2"
          >
            <input
              ref={inputRef}
              type="text"
              value={inputTitle}
              onChange={(e) => setInputTitle(e.target.value)}
              placeholder="Task title — Enter to add"
              disabled={busy}
              className="w-full border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none disabled:opacity-60"
            />
          </form>

          {/* Task list */}
          {items.length === 0 ? (
            <div className="text-[11px] italic text-muted-foreground/70">
              No quick tasks yet.
            </div>
          ) : (
            <ul className="max-h-52 divide-y divide-border/50 overflow-y-auto">
              {items.map((item) => (
                <li key={item.id} className="flex items-start gap-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => void handleComplete(item)}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm border border-muted-foreground/40 hover:border-primary hover:bg-primary/20"
                    title="Mark done"
                    aria-label={`Mark done: ${item.title}`}
                  />
                  <span className="min-w-0 flex-1 break-words text-xs leading-snug text-foreground">
                    {item.title}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
