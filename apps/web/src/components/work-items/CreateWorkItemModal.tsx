// Section: cross-cutting fix for "Add new work item button doesn't save"
// (2026-05-19). Opens when the inline + Add card on KanbanBoard hits a
// required-field validation error. Hosts a fuller create form so the user
// can fill the project's custom required fields before the server save.
//
// Explicit close only — no backdrop-click / Escape dismissal (modals host
// hard-to-redo work). Cancel button confirms discard if the user typed
// anything non-default.

import { useEffect, useMemo, useState } from 'react';

import type { Project } from '@/features/projects/client';
import { WORK_ITEM_TYPES, WorkItemFieldValidationError, workItemsApi, type FieldSchema, type WorkItem, type WorkItemType } from '@/features/work-items/client';
import { TypedFieldEditor } from './TypedFieldEditor';

const TYPE_LABELS: Record<WorkItemType, string> = {
  task: '▢ Task',
  bug: '🐛 Bug',
  feature: '✨ Feature',
  spike: '⚡ Spike',
  investigation: '🔍 Investigation',
};

interface CreateWorkItemModalProps {
  project: Project;
  stageId: string;
  /** Section 37.9 — when set, the new card lands as a sub-task of this work
   *  item. The Add task button in InitiativeInspector's Children tab passes
   *  the inspected item's id here. */
  parentId?: string | null;
  prefillTitle?: string;
  /** Seeded field errors when the modal opens from a failed inline create. */
  initialFieldErrors?: Record<string, string>;
  onClose: () => void;
  onCreated: (workItem: WorkItem) => void;
}

export function CreateWorkItemModal({
  project,
  stageId,
  parentId,
  prefillTitle = '',
  initialFieldErrors,
  onClose,
  onCreated,
}: CreateWorkItemModalProps) {
  const [title, setTitle] = useState(prefillTitle);
  const [body, setBody] = useState('');
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [stage, setStage] = useState(stageId);
  const [type, setType] = useState<WorkItemType>('task');
  const [schemas, setSchemas] = useState<FieldSchema[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>(
    initialFieldErrors ?? {},
  );

  useEffect(() => {
    let cancelled = false;
    workItemsApi.listFieldSchemas(project.id)
      .then((s) => {
        if (!cancelled) setSchemas(s);
      })
      .catch(() => {
        if (!cancelled) setSchemas([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const orderedSchemas = useMemo(
    () => [...schemas].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)),
    [schemas],
  );
  const stageOptions = useMemo(
    () => [...project.stages].sort((a, b) => a.order - b.order),
    [project.stages],
  );

  const dirty =
    title.trim() !== prefillTitle.trim() ||
    body.length > 0 ||
    Object.keys(fields).length > 0 ||
    stage !== stageId ||
    type !== 'task';

  function attemptClose() {
    if (busy) return;
    if (dirty) {
      const ok = window.confirm('Discard this new card? Your draft will be lost.');
      if (!ok) return;
    }
    onClose();
  }

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    setFieldErrors({});
    try {
      const r = await workItemsApi.createWorkItem(project.id, trimmed, stage, {
        ...(body.length > 0 ? { body } : {}),
        ...(type !== 'task' ? { type } : {}),
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
        ...(parentId ? { parentId } : {}),
      });
      onCreated(r.workItem);
      onClose();
    } catch (e) {
      if (e instanceof WorkItemFieldValidationError) {
        setFieldErrors(e.errors);
        setErr('Fix the highlighted fields and try again.');
      } else {
        setErr((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col border border-border bg-card text-foreground">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-base font-semibold">New task</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Fill any required fields, then create.
            </p>
          </div>
          <button
            onClick={attemptClose}
            disabled={busy}
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
            <Field label="Title">
              <input
                autoFocus
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Card title"
                className="w-full border border-border bg-background px-2 py-1 text-sm"
              />
            </Field>

            <Field label="Stage">
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value)}
                className="w-full border border-border bg-background px-2 py-1 text-sm"
              >
                {stageOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Type">
              <select
                value={type}
                onChange={(e) => setType(e.target.value as WorkItemType)}
                className="w-full border border-border bg-background px-2 py-1 text-sm"
              >
                {WORK_ITEM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Body">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder="Optional."
                className="w-full resize-y border border-border bg-background px-2 py-1 font-mono text-xs leading-relaxed"
              />
            </Field>

            {orderedSchemas.length > 0 && (
              <div className="flex flex-col gap-3">
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Fields
                </div>
                {orderedSchemas.map((schema) => (
                  <TypedFieldEditor
                    key={schema.id}
                    schema={schema}
                    value={fields[schema.key]}
                    onChange={(v) =>
                      setFields((p) => ({ ...p, [schema.key]: v }))
                    }
                    error={fieldErrors[schema.key] ?? null}
                  />
                ))}
              </div>
            )}

            {err && (
              <div className="border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                {err}
              </div>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
            <button
              type="button"
              onClick={attemptClose}
              disabled={busy}
              className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !title.trim()}
              className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
