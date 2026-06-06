// Section 2h — per-project stages editor.
//
// Bulk-PATCH shape. Existing stage ids are locked (workflow YAMLs reference
// them by id, so renaming = breaking trigger). New stages get a slug derived
// from their name, editable by the user. Delete-with-items: server returns
// 409 STAGE_HAS_ITEMS + orphan counts → inline prompt picks a fallback stage,
// then the editor retries with `force: true`.

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Project, Stage } from '@/features/projects/client';
import { StageHasItemsError, workItemsApi, type WorkItem } from '@/features/work-items/client';

interface DraftStage {
  rowId: string;
  /** Server id. For new rows we mint a slug client-side; the user can edit it before save. */
  id: string;
  /** True when this row's id matches an existing project stage. Locked after first save. */
  isExisting: boolean;
  name: string;
  order: number;
  /** Section 27 — terminal/intake flags. */
  isDone: boolean;
  isCancelled: boolean;
  isNew: boolean;
}

let rowIdCounter = 0;
function newRowId(): string {
  rowIdCounter += 1;
  return `s${rowIdCounter}`;
}

function rowFromStage(s: Stage): DraftStage {
  return {
    rowId: newRowId(),
    id: s.id,
    isExisting: true,
    name: s.name,
    order: s.order,
    isDone: s.isDone === true,
    isCancelled: s.isCancelled === true,
    isNew: s.isNew === true,
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface StagesEditorProps {
  project: Project;
  onProjectUpdated: (next: Project) => void;
}

export function StagesEditor({ project, onProjectUpdated }: StagesEditorProps) {
  const [rows, setRows] = useState<DraftStage[]>(() =>
    [...project.stages].sort((a, b) => a.order - b.order).map(rowFromStage),
  );
  const [loadedSig, setLoadedSig] = useState<string>(() =>
    JSON.stringify(project.stages.map((s) => ({ id: s.id, name: s.name, order: s.order }))),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [fallback, setFallback] = useState<{
    orphans: { id: string; name: string; count: number }[];
    fallbackStageId: string;
  } | null>(null);

  // Re-sync when the project prop changes (stages-changed broadcast → Shell refetch → new project prop).
  useEffect(() => {
    const sorted = [...project.stages].sort((a, b) => a.order - b.order);
    setRows(sorted.map(rowFromStage));
    setLoadedSig(
      JSON.stringify(
        sorted.map((s) => ({
          id: s.id,
          name: s.name,
          order: s.order,
          isDone: s.isDone === true,
          isCancelled: s.isCancelled === true,
          isNew: s.isNew === true,
        })),
      ),
    );
  }, [project]);

  const dirty = useMemo(() => {
    const cleaned = rows.map((r) => ({
      id: r.id.trim(),
      name: r.name.trim(),
      order: r.order,
      isDone: r.isDone,
      isCancelled: r.isCancelled,
      isNew: r.isNew,
    }));
    return JSON.stringify(cleaned) !== loadedSig;
  }, [rows, loadedSig]);

  function update(idx: number, patch: Partial<DraftStage>) {
    setRows((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx]!, ...patch };
      // For new rows, auto-derive id from name unless the user has already
      // customized it (heuristic: if id === slugify(prev name) keep auto-syncing).
      const row = next[idx]!;
      if (!row.isExisting && patch.name !== undefined) {
        const prevSlug = slugify(prev[idx]!.name);
        if (prev[idx]!.id === prevSlug || prev[idx]!.id === '') {
          row.id = slugify(patch.name);
        }
      }
      return next;
    });
  }

  function moveUp(idx: number) {
    if (idx === 0) return;
    setRows((prev) => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx]!, next[idx - 1]!];
      return reorder(next);
    });
  }

  function moveDown(idx: number) {
    setRows((prev) => {
      if (idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1]!, next[idx]!];
      return reorder(next);
    });
  }

  function remove(idx: number) {
    setRows((prev) => reorder(prev.filter((_, i) => i !== idx)));
  }

  function add() {
    setRows((prev) => [
      ...prev,
      {
        rowId: newRowId(),
        id: '',
        isExisting: false,
        name: '',
        order: prev.length,
        isDone: false,
        isCancelled: false,
        isNew: false,
      },
    ]);
  }

  function discard() {
    const sorted = [...project.stages].sort((a, b) => a.order - b.order);
    setRows(sorted.map(rowFromStage));
    setErr(null);
    setSaved(null);
    setFallback(null);
  }

  async function commitSave(stages: Stage[], force = false, fallbackStageId?: string) {
    setBusy(true);
    setErr(null);
    setSaved(null);
    try {
      const updated = await workItemsApi.replaceStages(project.id, stages, {
        force,
        ...(fallbackStageId ? { fallbackStageId } : {}),
      });
      onProjectUpdated(updated);
      setSaved('Saved.');
      setFallback(null);
    } catch (e) {
      if (e instanceof StageHasItemsError) {
        // Remaining stages (i.e. ones that survive this save) — fallback target picks from these.
        const remainingIds = new Set(stages.map((s) => s.id));
        const firstRemaining = [...remainingIds][0] ?? '';
        setFallback({ orphans: e.orphans, fallbackStageId: firstRemaining });
      } else {
        setErr((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const validation = validateRows(rows);
    if (validation) {
      setErr(validation);
      return;
    }
    const stages: Stage[] = rows.map((r) => ({
      id: r.id.trim(),
      name: r.name.trim(),
      order: r.order,
      ...(r.isDone ? { isDone: true } : {}),
      ...(r.isCancelled ? { isCancelled: true } : {}),
      ...(r.isNew ? { isNew: true } : {}),
    }));
    await commitSave(stages);
  }

  async function applyFallback() {
    if (!fallback) return;
    const stages: Stage[] = rows.map((r) => ({
      id: r.id.trim(),
      name: r.name.trim(),
      order: r.order,
      ...(r.isDone ? { isDone: true } : {}),
      ...(r.isCancelled ? { isCancelled: true } : {}),
      ...(r.isNew ? { isNew: true } : {}),
    }));
    if (!stages.some((s) => s.id === fallback.fallbackStageId)) {
      setErr('Pick a destination stage first.');
      return;
    }
    await commitSave(stages, true, fallback.fallbackStageId);
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {rows.map((row, idx) => (
          <li key={row.rowId} className="border border-border bg-card p-3">
            <StageRow
              row={row}
              onChange={(patch) => update(idx, patch)}
              onMoveUp={() => moveUp(idx)}
              onMoveDown={() => moveDown(idx)}
              onRemove={() => remove(idx)}
              isFirst={idx === 0}
              isLast={idx === rows.length - 1}
            />
          </li>
        ))}
      </ul>

      <button
        onClick={add}
        className="border border-border px-3 py-1 text-xs hover:bg-muted"
      >
        + Add stage
      </button>

      {fallback && (
        <FallbackPrompt
          orphans={fallback.orphans}
          remaining={rows.map((r) => ({ id: r.id.trim(), name: r.name.trim() }))}
          selected={fallback.fallbackStageId}
          onSelect={(id) => setFallback({ ...fallback, fallbackStageId: id })}
          onApply={() => void applyFallback()}
          onCancel={() => setFallback(null)}
          busy={busy}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button
          onClick={() => void save()}
          disabled={busy || !dirty}
          className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={discard}
          disabled={busy || !dirty}
          className="border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          Discard
        </button>
        {err && <span className="text-xs text-destructive">{err}</span>}
        {saved && <span className="text-xs text-success">{saved}</span>}
      </div>

      <ArchivedSection projectId={project.id} stages={project.stages} />
    </div>
  );
}

function ArchivedSection({
  projectId,
  stages,
}: {
  projectId: string;
  stages: Stage[];
}) {
  const [show, setShow] = useState(false);
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = useCallback(() => {
    workItemsApi.listArchivedWorkItems(projectId)
      .then(setItems)
      .catch((e: unknown) => setErr((e as Error).message));
  }, [projectId]);

  useEffect(() => {
    if (!show) return;
    setItems(null);
    setErr(null);
    load();
  }, [show, load]);

  const byStage = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const s of stages) map.set(s.id, []);
    map.set('__unknown__', []);
    for (const wi of items ?? []) {
      (map.get(wi.stageId) ?? map.get('__unknown__'))!.push(wi);
    }
    return map;
  }, [items, stages]);

  async function restore(wiId: string) {
    if (restoring) return;
    setRestoring(wiId);
    setErr(null);
    try {
      await workItemsApi.restoreWorkItem(projectId, wiId);
      setItems((prev) => prev?.filter((i) => i.id !== wiId) ?? null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div className="border-t border-border pt-3">
      <button
        onClick={() => setShow((s) => !s)}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <span aria-hidden>{show ? '▾' : '▸'}</span>
        <span>Show archived</span>
        {items && <span>· {items.length}</span>}
      </button>
      {show && (
        <div className="mt-2 space-y-3">
          {err && <p className="text-xs text-destructive">{err}</p>}
          {items === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-xs text-muted-foreground">No archived tasks.</p>
          ) : (
            <div className="space-y-2">
              {[...stages]
                .sort((a, b) => a.order - b.order)
                .map((stage) => {
                  const bucket = byStage.get(stage.id) ?? [];
                  if (bucket.length === 0) return null;
                  return (
                    <StageBucket
                      key={stage.id}
                      label={stage.name}
                      items={bucket}
                      restoringId={restoring}
                      onRestore={restore}
                    />
                  );
                })}
              {(byStage.get('__unknown__')?.length ?? 0) > 0 && (
                <StageBucket
                  label="(orphaned)"
                  items={byStage.get('__unknown__')!}
                  restoringId={restoring}
                  onRestore={restore}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StageBucket({
  label,
  items,
  restoringId,
  onRestore,
}: {
  label: string;
  items: WorkItem[];
  restoringId: string | null;
  onRestore: (wiId: string) => void;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label} · {items.length}
      </div>
      <ul className="mt-1 border border-border">
        {items.map((wi) => (
          <li
            key={wi.id}
            className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-xs last:border-b-0"
          >
            <span className="line-clamp-1 min-w-0 flex-1 break-words text-foreground">
              {wi.title}
            </span>
            <span
              className="shrink-0 text-[11px] text-muted-foreground"
              title={wi.deletedAt ? new Date(wi.deletedAt).toLocaleString() : ''}
            >
              {wi.deletedAt ? new Date(wi.deletedAt).toLocaleDateString() : ''}
            </span>
            <button
              onClick={() => onRestore(wi.id)}
              disabled={restoringId === wi.id}
              className="shrink-0 border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            >
              {restoringId === wi.id ? 'Restoring…' : 'Restore'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StageRow({
  row,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
  isFirst,
  isLast,
}: {
  row: DraftStage;
  onChange: (patch: Partial<DraftStage>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">#{row.order + 1}</span>
        <input
          type="text"
          value={row.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Stage name"
          className="flex-1 border border-border bg-background px-2 py-1 text-sm"
        />
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className="border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-30"
          aria-label="Move up"
        >
          ↑
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className="border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-30"
          aria-label="Move down"
        >
          ↓
        </button>
        <button
          onClick={onRemove}
          className="border border-destructive/60 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10"
        >
          Remove
        </button>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>id:</span>
        {row.isExisting ? (
          <code className="bg-muted px-1.5 py-0.5 font-mono">{row.id}</code>
        ) : (
          <input
            type="text"
            value={row.id}
            onChange={(e) => onChange({ id: e.target.value })}
            placeholder="auto-from-name"
            className="border border-border bg-background px-2 py-0.5 font-mono text-[11px]"
          />
        )}
        {row.isExisting ? (
          <span className="italic">locked — workflows + work items reference this id</span>
        ) : (
          <span className="italic">slug-style; locked once saved</span>
        )}
      </div>
      {/* Section 27 — terminal/intake flag checkboxes. At most one stage per
          project per flag (server validates; UI surfaces inline). */}
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
        <span className="font-medium uppercase tracking-wide">Flags:</span>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={row.isNew}
            onChange={(e) => onChange({ isNew: e.target.checked })}
          />
          <span>New (intake)</span>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={row.isDone}
            onChange={(e) => onChange({ isDone: e.target.checked })}
          />
          <span>Done</span>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={row.isCancelled}
            onChange={(e) => onChange({ isCancelled: e.target.checked })}
          />
          <span>Cancelled</span>
        </label>
      </div>
    </div>
  );
}

function FallbackPrompt({
  orphans,
  remaining,
  selected,
  onSelect,
  onApply,
  onCancel,
  busy,
}: {
  orphans: { id: string; name: string; count: number }[];
  remaining: { id: string; name: string }[];
  selected: string;
  onSelect: (id: string) => void;
  onApply: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const orphanCount = orphans.reduce((s, o) => s + o.count, 0);
  return (
    <div className="border border-warning/60 bg-warning/10 p-3">
      <div className="text-sm font-medium text-foreground">
        {orphanCount} task{orphanCount === 1 ? '' : 's'} live in stages you're about to remove.
      </div>
      <ul className="ml-4 mt-1 list-disc text-xs text-foreground/80">
        {orphans.map((o) => (
          <li key={o.id}>
            <span className="font-mono">{o.name}</span> · {o.count}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Move them to:</span>
        <select
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
          className="border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="">— pick a stage —</option>
          {remaining.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || s.id}
            </option>
          ))}
        </select>
        <button
          onClick={onApply}
          disabled={busy || !selected}
          className="bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Moving…' : 'Move and save'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="border border-border px-3 py-1 text-xs hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function reorder(rows: DraftStage[]): DraftStage[] {
  return rows.map((r, idx) => ({ ...r, order: idx }));
}

function validateRows(rows: DraftStage[]): string | null {
  if (rows.length === 0) return 'At least one stage is required.';
  const ids = new Set<string>();
  let doneCount = 0;
  let cancelledCount = 0;
  let newCount = 0;
  for (const r of rows) {
    const id = r.id.trim();
    const name = r.name.trim();
    if (!name) return `Row #${r.order + 1}: name required.`;
    if (!id) return `Row #${r.order + 1}: id required (derived from name).`;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
      return `Row #${r.order + 1}: id "${id}" must be lowercase letters/digits/_/- only.`;
    }
    if (ids.has(id)) return `Duplicate stage id: ${id}.`;
    ids.add(id);
    if (r.isDone) doneCount += 1;
    if (r.isCancelled) cancelledCount += 1;
    if (r.isNew) newCount += 1;
  }
  if (doneCount > 1) return 'At most one stage can be marked Done.';
  if (cancelledCount > 1) return 'At most one stage can be marked Cancelled.';
  if (newCount > 1) return 'At most one stage can be marked New (intake).';
  return null;
}
