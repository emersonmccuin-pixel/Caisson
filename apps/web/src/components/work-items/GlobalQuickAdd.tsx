// Slice 2 — global quick-add. A dumb, fast capture: title (+ optional note),
// Enter, gone. Now carries a destination dropdown: capture from anywhere, pick
// where it lands. Defaults to Command (the cross-cutting TODO) — unless opened
// from an area page (prefillAreaId set via the store), in which case it stays
// in the current project's area.
//
// Rendered once at the App level; opened via useGlobalQuickAdd().open(areaId?).

import { useEffect, useMemo, useRef, useState } from 'react';

import { COMMAND_PROJECT_SLUG } from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import { workItemsApi } from '@/features/work-items/client';
import { useGlobalQuickAdd } from '@/store/global-quick-add';

/** Find the intake (isNew) stage; fall back to the first stage. */
function intakeStageId(stages: Project['stages']): string {
  return stages.find((s) => s.isNew)?.id ?? stages[0]?.id ?? 'draft';
}

interface Props {
  projects: Project[];
  /** The project currently open in the shell — the prefill area belongs to it. */
  activeProjectId: string | null;
  onCreated?: () => void;
}

export function GlobalQuickAdd({ projects, activeProjectId, onCreated }: Props) {
  const { isOpen, prefillAreaId, prefillAreaName, close } = useGlobalQuickAdd();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [destId, setDestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const commandProject = useMemo(
    () => projects.find((p) => p.slug === COMMAND_PROJECT_SLUG) ?? null,
    [projects],
  );
  // Command first in the dropdown, then the rest in list order.
  const orderedProjects = useMemo(() => {
    const rest = projects.filter((p) => p.slug !== COMMAND_PROJECT_SLUG);
    return commandProject ? [commandProject, ...rest] : rest;
  }, [projects, commandProject]);

  // Default destination: stay in the current project when capturing from an
  // area (the area only makes sense there); otherwise default to Command.
  const defaultDestId =
    (prefillAreaId ? activeProjectId : null) ??
    commandProject?.id ??
    activeProjectId ??
    orderedProjects[0]?.id ??
    null;

  // Reset on open.
  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setNote('');
      setErr(null);
      setDestId(defaultDestId);
      setTimeout(() => titleRef.current?.focus(), 10);
    }
    // defaultDestId is derived from the open-time prefill; intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const dest = orderedProjects.find((p) => p.id === destId) ?? null;
  // The prefill area belongs to the active project; keep it only while the
  // destination is still that project (switching destination drops the area).
  const useArea = prefillAreaId != null && destId === activeProjectId;
  const areaName = useArea ? (prefillAreaName ?? 'selected area') : 'Uncaptured';

  async function submit() {
    const t = title.trim();
    if (!t || busy || !dest) return;
    setBusy(true);
    setErr(null);
    try {
      await workItemsApi.createWorkItem(dest.id, t, intakeStageId(dest.stages), {
        ...(note.trim() ? { body: note.trim() } : {}),
        ...(useArea && prefillAreaId ? { areaId: prefillAreaId } : {}),
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
              Quick task
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

          <div className="flex items-center gap-2">
            <select
              value={destId ?? ''}
              onChange={(e) => setDestId(e.target.value)}
              aria-label="Destination project"
              className="min-w-0 flex-1 border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none"
            >
              {orderedProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.slug === COMMAND_PROJECT_SLUG ? `★ ${p.name}` : p.name}
                </option>
              ))}
            </select>
            {useArea && (
              <span className="shrink-0 text-[11px] text-muted-foreground" title="Area">
                → {areaName}
              </span>
            )}
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
