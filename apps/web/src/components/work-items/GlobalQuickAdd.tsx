// Slice 2 — global quick-add. A dumb, fast capture: title (+ optional note),
// Enter, gone. Defaults: intake stage, Uncaptured area — unless opened from an
// area page (prefillAreaId set via the store). Deliberately minimal.
//
// Rendered once at the App level; opened via useGlobalQuickAdd().open(areaId?).

import { useEffect, useRef, useState } from 'react';

import type { Project } from '@/features/projects/client';
import { workItemsApi } from '@/features/work-items/client';
import { useGlobalQuickAdd } from '@/store/global-quick-add';

/** Find the intake (isNew) stage; fall back to the first stage. */
function intakeStageId(stages: Project['stages']): string {
  return stages.find((s) => s.isNew)?.id ?? stages[0]?.id ?? 'draft';
}

interface Props {
  project: Project;
  onCreated?: () => void;
}

export function GlobalQuickAdd({ project, onCreated }: Props) {
  const { isOpen, prefillAreaId, prefillAreaName, close } = useGlobalQuickAdd();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Reset on open.
  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setNote('');
      setErr(null);
      setTimeout(() => titleRef.current?.focus(), 10);
    }
  }, [isOpen]);

  // Escape to close.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  if (!isOpen) return null;

  const areaName = prefillAreaId ? (prefillAreaName ?? 'selected area') : 'Uncaptured';

  async function submit() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await workItemsApi.createWorkItem(project.id, t, intakeStageId(project.stages), {
        ...(note.trim() ? { body: note.trim() } : {}),
        ...(prefillAreaId ? { areaId: prefillAreaId } : {}),
      });
      close();
      onCreated?.();
    } catch (e: unknown) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[20vh] bg-black/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-md border border-border bg-card shadow-2xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-3 p-4"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              Quick task · {areaName}
            </span>
            <button
              type="button"
              onClick={close}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <input
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title — Enter to capture"
            className="w-full border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            rows={2}
            className="w-full resize-none border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />

          {err && (
            <div className="border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
              {err}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !title.trim()}
              className="bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? 'Capturing…' : 'Capture'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
