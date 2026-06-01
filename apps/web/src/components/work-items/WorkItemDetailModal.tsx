// Section 2d — detail modal Overview tab + footer wiring.
//
// Tabs: Overview (this phase) · Children (2e) · Attachments (2f) · Activity (2i).
// Save = version-checked PATCH; 409 surfaces an inline reload prompt. WS-driven
// prop updates: silent re-sync when not dirty, "remote changed" banner when the
// user has unsaved edits and the prop's version has advanced.

import { useEffect, useMemo, useRef, useState } from 'react';

import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import type { Project } from '@/features/projects/client';
import type { Area } from '@/features/areas/client';
import { WORK_ITEM_TYPES, WorkItemConflictError, WorkItemFieldValidationError, workItemsApi, type Attachment, type FieldSchema, type WorkItem, type WorkItemPatch, type WorkItemType } from '@/features/work-items/client';
import { attachmentChangedFromLiveFrame } from '@/features/work-items/attachment-live-events';
import { latestFieldSchemas, workItemHistoryRows } from '@/features/work-items/work-item-live-events';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useProjectAreas } from '@/hooks/use-project-areas';
import { useLiveEvents } from '@/store/live-store';
import { TypedFieldEditor } from './TypedFieldEditor';

type TabId = 'overview' | 'children' | 'attachments' | 'activity';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'children', label: 'Children' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'activity', label: 'Activity' },
];

interface WorkItemDetailModalProps {
  workItem: WorkItem;
  project: Project;
  items: WorkItem[];
  events: WsEnvelope[];
  onClose: () => void;
  onSwitchItem: (id: string) => void;
  /** Optimistic insert into the parent's items list. Used by "+ New child" so
   *  switching to the freshly-created child doesn't unmount the modal in the
   *  gap between create-response and WS-driven refetch. */
  onItemCreated: (wi: WorkItem) => void;
}

interface Draft {
  title: string;
  body: string;
  stageId: string;
  type: WorkItemType;
  areaId: string | null;
  fields: Record<string, unknown>;
}

function draftFromItem(wi: WorkItem): Draft {
  return {
    title: wi.title,
    body: wi.body,
    stageId: wi.stageId,
    type: wi.type ?? 'task',
    areaId: wi.areaId ?? null,
    fields: { ...(wi.fields ?? {}) },
  };
}

function isDirty(draft: Draft, baseline: WorkItem): boolean {
  if (draft.title !== baseline.title) return true;
  if (draft.body !== baseline.body) return true;
  if (draft.stageId !== baseline.stageId) return true;
  if (draft.type !== (baseline.type ?? 'task')) return true;
  if (draft.areaId !== (baseline.areaId ?? null)) return true;
  return !shallowEqualRecord(draft.fields, baseline.fields ?? {});
}

const TYPE_LABELS: Record<WorkItemType, string> = {
  task: '▢ Task',
  bug: '🐛 Bug',
  feature: '✨ Feature',
  spike: '⚡ Spike',
};

function shallowEqualRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!fieldValueEqual(a[k], b[k])) return false;
  }
  return true;
}

function fieldValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  // Cheap deep-equal via JSON for the few cases (arrays of strings on enum options, etc.)
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function WorkItemDetailModal({
  workItem,
  project,
  items,
  events,
  onClose,
  onSwitchItem,
  onItemCreated,
}: WorkItemDetailModalProps) {
  const [tab, setTab] = useState<TabId>('overview');
  const [baseline, setBaseline] = useState<WorkItem>(workItem);
  const [draft, setDraft] = useState<Draft>(() => draftFromItem(workItem));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<WorkItem | null>(null);
  const [remoteChanged, setRemoteChanged] = useState<WorkItem | null>(null);
  const [fieldSchemas, setFieldSchemas] = useState<FieldSchema[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Slice 010 — Area dropdown options. useProjectAreas refetches on any area
  // frame, so options stay live while the modal is open.
  const { areas } = useProjectAreas(project, events);

  useEffect(() => {
    let cancelled = false;
    workItemsApi.listFieldSchemas(project.id)
      .then((s) => {
        if (!cancelled) setFieldSchemas(s);
      })
      .catch(() => {
        if (!cancelled) setFieldSchemas([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // T3.2b — field-schema changes off the identity-keyed live store (Q1-A keyed
  // the frame by projectId so it enters the store). Latest-by-cursor wins.
  const schemaEvents = useLiveEvents('field-schema', project.id);
  useEffect(() => {
    const schemas = latestFieldSchemas(schemaEvents);
    if (schemas) setFieldSchemas(schemas);
  }, [schemaEvents]);

  // Re-sync when the parent passes us a new (or refreshed) work item.
  // - Different id: parent breadcrumb switched targets — reset everything.
  // - Same id, newer version, not dirty: silently adopt the new state.
  // - Same id, newer version, dirty: keep draft; surface a "remote changed" banner.
  useEffect(() => {
    if (workItem.id !== baseline.id) {
      setBaseline(workItem);
      setDraft(draftFromItem(workItem));
      setRemoteChanged(null);
      setConflict(null);
      setError(null);
      return;
    }
    if (workItem.version === baseline.version) return;
    if (isDirty(draft, baseline)) {
      setRemoteChanged(workItem);
    } else {
      setBaseline(workItem);
      setDraft(draftFromItem(workItem));
    }
  }, [workItem, baseline, draft]);

  const dirty = isDirty(draft, baseline);

  function confirmDiscardIfDirty(): boolean {
    if (!dirty) return true;
    return window.confirm('Discard unsaved changes?');
  }

  function attemptClose() {
    if (confirmDiscardIfDirty()) onClose();
  }

  function attemptSwitch(id: string) {
    if (confirmDiscardIfDirty()) onSwitchItem(id);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') attemptClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // attemptClose closes over `dirty`; refresh listener whenever dirty flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  async function save() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    setFieldErrors({});
    try {
      const patch: WorkItemPatch = {};
      if (draft.title !== baseline.title) patch.title = draft.title;
      if (draft.body !== baseline.body) patch.body = draft.body;
      if (draft.stageId !== baseline.stageId) patch.stageId = draft.stageId;
      if (draft.type !== (baseline.type ?? 'task')) patch.type = draft.type;
      if (draft.areaId !== (baseline.areaId ?? null)) patch.areaId = draft.areaId;
      if (!shallowEqualRecord(draft.fields, baseline.fields ?? {})) {
        patch.fields = draft.fields;
      }
      const updated = await workItemsApi.patchWorkItem(
        project.id,
        baseline.id,
        baseline.version,
        patch,
      );
      setBaseline(updated);
      setDraft(draftFromItem(updated));
      setRemoteChanged(null);
    } catch (e) {
      if (e instanceof WorkItemConflictError) {
        setConflict(e.current);
      } else if (e instanceof WorkItemFieldValidationError) {
        setFieldErrors(e.errors);
        setError('Fix the highlighted fields and try again.');
        setTab('overview');
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  function reloadFromServer(next: WorkItem) {
    setBaseline(next);
    setDraft(draftFromItem(next));
    setConflict(null);
    setRemoteChanged(null);
    setError(null);
  }

  async function softDelete() {
    if (busy) return;
    const ok = window.confirm(
      `Archive "${baseline.title}"?\n\nThe item is hidden but can be restored from Project settings → Stages → Show archived.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await workItemsApi.softDeleteWorkItem(project.id, baseline.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const parent = baseline.parentId
    ? items.find((i) => i.id === baseline.parentId) ?? null
    : null;
  const stageOptions = useMemo(
    () => [...project.stages].sort((a, b) => a.order - b.order),
    [project.stages],
  );
  const children = useMemo(
    () =>
      items
        .filter((i) => i.parentId === baseline.id)
        .sort((a, b) => a.position - b.position),
    [items, baseline.id],
  );
  const stageNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of project.stages) m.set(s.id, s.name);
    return m;
  }, [project.stages]);

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/40"
      onClick={attemptClose}
    >
      <div
        className="flex h-[80vh] w-full max-w-3xl flex-col border border-border bg-card text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            {/* Section 35 — callsign chip; click-to-copy. NULL on agent
                contracts so this block stays absent for those. */}
            {baseline.callsign && <CallsignChip callsign={baseline.callsign} />}
            <input
              type="text"
              value={draft.title}
              onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
              placeholder="Untitled"
              className="w-full bg-transparent text-base font-semibold text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Title"
            />
            <p className="mt-0.5 text-xs text-muted-foreground">
              v{baseline.version} · {baseline.status}
              {baseline.statusReason && (
                <span className="ml-1 text-muted-foreground/70">
                  ({baseline.statusReason})
                </span>
              )}
            </p>
          </div>
          <button
            onClick={attemptClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <nav className="flex gap-1 border-b border-border px-2 pt-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={
                'flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm transition-colors ' +
                (tab === t.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground')
              }
            >
              <span>{t.label}</span>
              {t.id === 'children' && children.length > 0 && (
                <span className="border border-border px-1 text-[10px] font-normal text-muted-foreground">
                  {children.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {conflict && (
            <ConflictBanner
              kind="conflict"
              current={conflict}
              onReload={() => reloadFromServer(conflict)}
              onDismiss={() => setConflict(null)}
            />
          )}
          {!conflict && remoteChanged && (
            <ConflictBanner
              kind="remote"
              current={remoteChanged}
              onReload={() => reloadFromServer(remoteChanged)}
              onDismiss={() => setRemoteChanged(null)}
            />
          )}

          {tab === 'overview' && (
            <OverviewTab
              workItem={baseline}
              draft={draft}
              setDraft={setDraft}
              parent={parent}
              stages={stageOptions}
              areas={areas}
              fieldSchemas={fieldSchemas}
              fieldErrors={fieldErrors}
              onSwitchToParent={() => parent && attemptSwitch(parent.id)}
            />
          )}
          {tab === 'children' && (
            <ChildrenTab
              projectId={project.id}
              parent={baseline}
              children={children}
              stageNameById={stageNameById}
              onSwitch={attemptSwitch}
              onCreated={(child) => {
                onItemCreated(child);
                onSwitchItem(child.id);
              }}
            />
          )}
          {tab === 'attachments' && (
            <AttachmentsTab
              projectId={project.id}
              workItemId={baseline.id}
              events={events}
            />
          )}
          {tab === 'activity' && (
            <ActivityTab
              projectId={project.id}
              workItem={baseline}
              events={events}
              stageNameById={stageNameById}
            />
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={() => void softDelete()}
            disabled={busy}
            className="mr-auto border border-destructive/40 bg-background px-3 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
            title="Archive this work item"
          >
            Archive
          </button>
          {error && (
            <span
              className="mr-2 truncate text-xs text-destructive"
              title={error}
            >
              {error}
            </span>
          )}
          {!error && dirty && (
            <span className="mr-2 text-xs text-muted-foreground">
              unsaved changes
            </span>
          )}
          <button
            onClick={attemptClose}
            className="border border-border bg-background px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
            disabled={busy}
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!dirty || busy}
            className="bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Section 35 — callsign chip rendered above the title in the modal header.
 *  Click copies the callsign string to the clipboard with a transient
 *  "copied!" tooltip so the user can paste it into a chat or doc. NULL on
 *  agent contracts, so the parent skips rendering this entirely. */
function CallsignChip({ callsign }: { callsign: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      .writeText(callsign)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        /* clipboard may be denied in non-secure contexts; silently no-op */
      });
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied!' : 'Copy callsign'}
      className="mb-1 inline-flex items-center gap-1 border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <span>{callsign}</span>
      {copied && <span className="text-success">✓</span>}
    </button>
  );
}

function ConflictBanner({
  kind,
  current,
  onReload,
  onDismiss,
}: {
  kind: 'conflict' | 'remote';
  current: WorkItem;
  onReload: () => void;
  onDismiss: () => void;
}) {
  const headline =
    kind === 'conflict'
      ? 'Save failed: this item changed elsewhere.'
      : 'This item just changed elsewhere.';
  return (
    <div className="mb-3 flex items-start gap-2 border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{headline}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          Server is at v{current.version}. Reload replaces your draft with the latest.
        </div>
      </div>
      <button
        onClick={onReload}
        className="border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
      >
        Reload
      </button>
      <button
        onClick={onDismiss}
        className="px-1 text-xs text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

function OverviewTab({
  workItem,
  draft,
  setDraft,
  parent,
  stages,
  areas,
  fieldSchemas,
  fieldErrors,
  onSwitchToParent,
}: {
  workItem: WorkItem;
  draft: Draft;
  setDraft: (next: Draft | ((p: Draft) => Draft)) => void;
  parent: WorkItem | null;
  stages: { id: string; name: string }[];
  areas: Area[];
  fieldSchemas: FieldSchema[];
  fieldErrors: Record<string, string>;
  onSwitchToParent: () => void;
}) {
  const sortedAreas = useMemo(
    () => [...areas].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [areas],
  );
  const orderedSchemas = useMemo(
    () => [...fieldSchemas].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)),
    [fieldSchemas],
  );
  const schemaKeys = useMemo(() => new Set(orderedSchemas.map((s) => s.key)), [orderedSchemas]);
  const orphanEntries = Object.entries(draft.fields).filter(([k]) => !schemaKeys.has(k));
  return (
    <div className="flex flex-col gap-4 text-foreground">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Stage">
          <select
            value={draft.stageId}
            onChange={(e) => setDraft((p) => ({ ...p, stageId: e.target.value }))}
            className="w-full border border-border bg-background px-2 py-1 text-sm"
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Type">
          <select
            value={draft.type}
            onChange={(e) =>
              setDraft((p) => ({ ...p, type: e.target.value as WorkItemType }))
            }
            className="w-full border border-border bg-background px-2 py-1 text-sm"
          >
            {WORK_ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Parent">
          {parent ? (
            <button
              onClick={onSwitchToParent}
              className="w-full truncate border border-border bg-muted/30 px-2 py-1 text-left text-sm text-foreground hover:bg-muted"
              title={parent.title}
            >
              ↑ {parent.title}
            </button>
          ) : (
            <div className="px-2 py-1 text-sm text-muted-foreground">
              — (top-level)
            </div>
          )}
        </Field>
        <Field label="Area">
          <select
            value={draft.areaId ?? ''}
            onChange={(e) =>
              setDraft((p) => ({ ...p, areaId: e.target.value === '' ? null : e.target.value }))
            }
            className="w-full border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="">none (Uncaptured)</option>
            {sortedAreas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Body">
        <textarea
          value={draft.body}
          onChange={(e) => setDraft((p) => ({ ...p, body: e.target.value }))}
          rows={10}
          className="w-full resize-y border border-border bg-background px-2 py-1 font-mono text-xs leading-relaxed text-foreground"
          placeholder="No body."
        />
      </Field>

      {orderedSchemas.length === 0 && orphanEntries.length === 0 ? (
        <Field label="Fields">
          <div className="border border-dashed border-border px-2 py-3 text-xs text-muted-foreground">
            No field schemas configured for this project. Add some in Project
            settings → Field schemas.
          </div>
        </Field>
      ) : (
        <Field label="Fields">
          <div className="flex flex-col gap-3">
            {orderedSchemas.map((schema) => (
              <TypedFieldEditor
                key={schema.id}
                schema={schema}
                value={draft.fields[schema.key]}
                onChange={(v) =>
                  setDraft((p) => ({
                    ...p,
                    fields: { ...p.fields, [schema.key]: v },
                  }))
                }
                error={fieldErrors[schema.key] ?? null}
              />
            ))}
            {orphanEntries.length > 0 && (
              <div className="border-t border-border pt-2">
                <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Orphan fields (no schema)
                </div>
                <div className="border border-dashed border-border">
                  {orphanEntries.map(([k, v]) => (
                    <div
                      key={k}
                      className="flex items-start gap-3 border-b border-border/60 px-2 py-1.5 last:border-b-0"
                    >
                      <div
                        className="w-32 shrink-0 truncate font-mono text-xs text-muted-foreground"
                        title={k}
                      >
                        {k}
                      </div>
                      <div className="min-w-0 flex-1 break-words font-mono text-xs text-foreground">
                        {renderFieldValue(v)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Field>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
        <span>v{workItem.version}</span>
        <span aria-hidden>·</span>
        <span title={new Date(workItem.createdAt).toLocaleString()}>
          created {formatRelative(workItem.createdAt)}
        </span>
        <span aria-hidden>·</span>
        <span title={new Date(workItem.updatedAt).toLocaleString()}>
          updated {formatRelative(workItem.updatedAt)}
        </span>
      </div>
    </div>
  );
}

function renderFieldValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v.length === 0 ? '""' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (abs < minute) return 'just now';
  const future = diff < 0;
  let value: string;
  if (abs < hour) value = `${Math.round(abs / minute)}m`;
  else if (abs < day) value = `${Math.round(abs / hour)}h`;
  else if (abs < week) value = `${Math.round(abs / day)}d`;
  else value = `${Math.round(abs / week)}w`;
  return future ? `in ${value}` : `${value} ago`;
}

function ChildrenTab({
  projectId,
  parent,
  children,
  stageNameById,
  onSwitch,
  onCreated,
}: {
  projectId: string;
  parent: WorkItem;
  children: WorkItem[];
  stageNameById: Map<string, string>;
  onSwitch: (id: string) => void;
  onCreated: (child: WorkItem) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await workItemsApi.createWorkItem(projectId, trimmed, parent.stageId, {
        parentId: parent.id,
      });
      setTitle('');
      setCreating(false);
      onCreated(r.workItem);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {children.length === 0 ? (
        <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No children yet.
        </div>
      ) : (
        <div className="border border-border">
          {children.map((child) => (
            <button
              key={child.id}
              onClick={() => onSwitch(child.id)}
              className="flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-muted"
            >
              <span className="line-clamp-1 min-w-0 flex-1 break-words text-sm text-foreground">
                {child.title}
              </span>
              <span className="shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
                {stageNameById.get(child.stageId) ?? child.stageId}
              </span>
            </button>
          ))}
        </div>
      )}

      {creating ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-2 border border-border p-2"
        >
          <input
            autoFocus
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Child title"
            className="border border-border bg-background px-2 py-1 text-sm"
          />
          {err && <div className="text-xs text-destructive">{err}</div>}
          <div className="flex gap-1">
            <button
              type="submit"
              disabled={busy || !title.trim()}
              className="bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setTitle('');
                setErr(null);
              }}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Defaults to parent's stage ({stageNameById.get(parent.stageId) ?? parent.stageId}).
          </p>
        </form>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="self-start px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          + New child
        </button>
      )}
    </div>
  );
}

function AttachmentsTab({
  projectId,
  workItemId,
  events,
}: {
  projectId: string;
  workItemId: string;
  events: WsEnvelope[];
}) {
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refetch = () => {
    workItemsApi.listAttachments(projectId, workItemId)
      .then(setItems)
      .catch((e) => setErr((e as Error).message));
  };

  useEffect(() => {
    setItems(null);
    setExpandedId(null);
    setErr(null);
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, workItemId]);

  const attachLastIdx = useRef(0);
  useEffect(() => {
    if (events.length < attachLastIdx.current) attachLastIdx.current = 0;
    const start = attachLastIdx.current;
    attachLastIdx.current = events.length;
    if (start >= events.length) return;
    for (let i = start; i < events.length; i++) {
      const env = events[i];
      if (env?.type === 'attachment-changed' && env.workItemId === workItemId) {
        refetch();
        break;
      }
      // Slice 017 Fix 3 — also react to the canonical relay frame.
      const live = attachmentChangedFromLiveFrame(env);
      if (live && live.workItemId === workItemId) {
        refetch();
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, workItemId]);

  async function del(aId: string) {
    if (!window.confirm('Delete this attachment? This cannot be undone.')) return;
    try {
      await workItemsApi.deleteAttachment(projectId, workItemId, aId);
      setItems((prev) => prev?.filter((a) => a.id !== aId) ?? null);
      if (expandedId === aId) setExpandedId(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (err) {
    return (
      <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {err}
      </div>
    );
  }
  if (items === null) {
    return <div className="text-xs text-muted-foreground">Loading…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        No attachments yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {items.map((att) => (
        <AttachmentRow
          key={att.id}
          attachment={att}
          expanded={expandedId === att.id}
          onToggle={() => setExpandedId((p) => (p === att.id ? null : att.id))}
          onDelete={() => void del(att.id)}
        />
      ))}
    </div>
  );
}

function AttachmentRow({
  attachment,
  expanded,
  onToggle,
  onDelete,
}: {
  attachment: Attachment;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const source = attachment.runId
    ? `run ${attachment.runId.slice(-8)}`
    : attachment.createdBySessionId
      ? `session ${attachment.createdBySessionId.slice(-8)}`
      : 'chat';
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="shrink-0 border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {attachment.kind}
          </span>
          <span className="line-clamp-1 min-w-0 flex-1 break-words text-sm text-foreground">
            {attachment.name}
          </span>
          <span
            className="shrink-0 text-[11px] text-muted-foreground"
            title={new Date(attachment.createdAt).toLocaleString()}
          >
            {source} · {formatRelative(attachment.createdAt)}
          </span>
          <span aria-hidden className="shrink-0 text-xs text-muted-foreground">
            {expanded ? '▾' : '▸'}
          </span>
        </button>
        <button
          onClick={onDelete}
          className="shrink-0 border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
          aria-label={`Delete ${attachment.name}`}
        >
          Delete
        </button>
      </div>
      {expanded && (
        <div className="border-t border-border bg-background px-3 py-2">
          <AttachmentBody attachment={attachment} />
        </div>
      )}
    </div>
  );
}

function AttachmentBody({ attachment }: { attachment: Attachment }) {
  const kind = (attachment.kind || '').toLowerCase();
  if (kind === 'markdown' || kind === 'md') {
    return (
      <div className="prose prose-sm prose-invert max-w-none text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
          {attachment.content}
        </ReactMarkdown>
      </div>
    );
  }
  if (kind === 'json') {
    let pretty = attachment.content;
    try {
      pretty = JSON.stringify(JSON.parse(attachment.content), null, 2);
    } catch {
      // fall back to raw content
    }
    return (
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground">
        {pretty}
      </pre>
    );
  }
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground">
      {attachment.content}
    </pre>
  );
}

interface ActivityRow {
  ts: number;
  actor: string;
  text: string;
}

function ActivityTab({
  projectId,
  workItem,
  events,
  stageNameById,
}: {
  projectId: string;
  workItem: WorkItem;
  events: WsEnvelope[];
  stageNameById: Map<string, string>;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // T3.2b — work-item history rows off the live store (rebuild-proof), filtered
  // to this open item. Replaces the positional `events[]` scan in the memo.
  const wiEvents = useLiveEvents('work-item', projectId);

  const refetchAttachments = () => {
    workItemsApi.listAttachments(projectId, workItem.id)
      .then(setAttachments)
      .catch((e) => setErr((e as Error).message));
  };

  useEffect(() => {
    setAttachments([]);
    setErr(null);
    refetchAttachments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, workItem.id]);

  const attach2LastIdx = useRef(0);
  useEffect(() => {
    if (events.length < attach2LastIdx.current) attach2LastIdx.current = 0;
    const start = attach2LastIdx.current;
    attach2LastIdx.current = events.length;
    if (start >= events.length) return;
    for (let i = start; i < events.length; i++) {
      const env = events[i];
      if (env?.type === 'attachment-changed' && env.workItemId === workItem.id) {
        refetchAttachments();
        break;
      }
      // Slice 017 Fix 3 — also react to the canonical relay frame.
      const live = attachmentChangedFromLiveFrame(env);
      if (live && live.workItemId === workItem.id) {
        refetchAttachments();
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, workItem.id]);

  const rows = useMemo<ActivityRow[]>(() => {
    const out: ActivityRow[] = [];
    out.push({
      ts: workItem.createdAt,
      actor: 'system',
      text: `Created in stage "${stageNameById.get(workItem.stageId) ?? workItem.stageId}"`,
    });
    if (workItem.updatedAt > workItem.createdAt) {
      out.push({
        ts: workItem.updatedAt,
        actor: 'edit',
        text: `Last updated · v${workItem.version} · stage "${stageNameById.get(workItem.stageId) ?? workItem.stageId}"`,
      });
    }
    if (workItem.deletedAt) {
      out.push({
        ts: workItem.deletedAt,
        actor: 'archive',
        text: 'Archived',
      });
    }
    for (const a of attachments) {
      out.push({
        ts: a.createdAt,
        actor: a.runId
          ? `run ${a.runId.slice(-8)}`
          : a.createdBySessionId
            ? `session ${a.createdBySessionId.slice(-8)}`
            : 'chat',
        text: `Attached ${a.name} (${a.kind})`,
      });
    }
    // 16b.7 — agent-comms audit rows written by the four pc_*_agent /
    // pc_ask_* HTTP routes. Persisted on workItem.history, so they survive
    // refresh and don't depend on a live WS subscription.
    for (const entry of workItem.history) {
      if (!entry.kind.startsWith('agent-')) continue;
      const ts = Date.parse(entry.ts);
      if (!Number.isFinite(ts)) continue;
      const actor = entry.agentName ? `agent ${entry.agentName}` : 'agent';
      out.push({
        ts,
        actor,
        text: entry.note ?? entry.kind,
      });
    }
    // T3.2b — live work-item edits this session, off the live store, filtered to
    // this item.
    for (const row of workItemHistoryRows(wiEvents, workItem.id)) {
      out.push(row);
    }
    // Newest first; dedupe by (ts + text).
    out.sort((a, b) => b.ts - a.ts);
    const seen = new Set<string>();
    return out.filter((r) => {
      const k = `${r.ts}:${r.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [workItem, attachments, wiEvents, stageNameById]);

  if (err) {
    return (
      <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {err}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        No activity yet.
      </div>
    );
  }
  return (
    <ul className="flex flex-col">
      {rows.map((row, idx) => (
        <li
          key={`${row.ts}-${idx}`}
          className="flex items-start gap-3 border-b border-border px-1 py-1.5 text-sm last:border-b-0"
        >
          <span
            className="w-20 shrink-0 text-[11px] text-muted-foreground"
            title={new Date(row.ts).toLocaleString()}
          >
            {formatRelative(row.ts)}
          </span>
          <span className="w-24 shrink-0 truncate text-[11px] uppercase tracking-wider text-muted-foreground">
            {row.actor}
          </span>
          <span className="min-w-0 flex-1 break-words text-foreground">{row.text}</span>
        </li>
      ))}
    </ul>
  );
}

