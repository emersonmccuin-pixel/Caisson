// Section 17d.5 — Context tab (the agent's attached context docs).
//
// List of context docs attached to the agent (agent-scoped `context_docs`
// rows — migration 0055 merged the old knowledge table in). The agent reads
// them at runtime via pc_get_context_doc. Row click expands inline with
// Save/Cancel. "Add" button appends a new blank row pre-opened for editing.
// Delete asks for confirm (soft delete server-side).

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import type { ULID } from '@/features/projects/client';
import { agentsApi, type AgentContextDoc, type PodBundle } from '@/features/agents/client';
import { Markdown } from '../Markdown';

interface ContextTabProps {
  podId: ULID;
  bundle: PodBundle | null;
  loading: boolean;
  error: string | null;
  onChanged: () => void;
  /** When true: Add / Edit / Delete buttons are hidden so the section becomes
   *  a pure rendered-markdown viewer. Used whenever a built-in (stock) pod is
   *  opened — built-ins are controlled centrally and view-only; clone into a
   *  project to customize. */
  readOnly?: boolean;
  /** Compact list mode for summary surfaces such as the project Agents tab. */
  collapseDocsByDefault?: boolean;
  previewLineCount?: number;
}

interface EditState {
  /** New (unsaved) rows have a synthetic id and no real DB row yet. */
  id: string;
  isNew: boolean;
  draft: { title: string; body: string };
}

export function ContextTab({
  podId,
  bundle,
  loading,
  error,
  onChanged,
  readOnly,
  collapseDocsByDefault = false,
  previewLineCount = 3,
}: ContextTabProps) {
  const [edit, setEdit] = useState<EditState | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function startNew() {
    setOpError(null);
    setEdit({
      id: `__new__${Date.now()}`,
      isNew: true,
      draft: { title: '', body: '' },
    });
  }

  function startEdit(row: AgentContextDoc) {
    setOpError(null);
    setEdit({
      id: row.id,
      isNew: false,
      draft: { title: row.title, body: row.body },
    });
  }

  function cancelEdit() {
    setEdit(null);
    setOpError(null);
  }

  async function save() {
    if (!edit || busy) return;
    const title = edit.draft.title.trim();
    if (!title) {
      setOpError('Title is required.');
      return;
    }
    setBusy(true);
    setOpError(null);
    try {
      if (edit.isNew) {
        await agentsApi.createAgentDoc(podId, { title, body: edit.draft.body });
      } else {
        await agentsApi.patchAgentDoc(podId, edit.id as ULID, {
          title,
          body: edit.draft.body,
        });
      }
      setEdit(null);
      onChanged();
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: AgentContextDoc) {
    const ok = window.confirm(`Delete context doc "${row.title}"?`);
    if (!ok) return;
    setBusy(true);
    setOpError(null);
    try {
      await agentsApi.deleteAgentDoc(podId, row.id);
      if (edit?.id === row.id) setEdit(null);
      onChanged();
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="text-xs text-muted-foreground">Loading…</div>;
  if (error) return <div className="text-xs text-destructive">{error}</div>;
  if (!bundle) return null;

  const rows = bundle.contextDocs;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {rows.length} context {rows.length === 1 ? 'doc' : 'docs'}
        </div>
        {!readOnly && (
          <button
            type="button"
            onClick={startNew}
            disabled={busy || edit !== null}
            className="border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            + Add doc
          </button>
        )}
      </div>

      {opError && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {opError}
        </div>
      )}

      {edit?.isNew && (
        <DocEditor
          edit={edit}
          busy={busy}
          onChange={(patch) =>
            setEdit((p) => (p ? { ...p, draft: { ...p.draft, ...patch } } : p))
          }
          onSave={save}
          onCancel={cancelEdit}
        />
      )}

      {rows.length === 0 && !edit?.isNew ? (
        <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No context docs yet. Add one to give this agent reference material.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((row) =>
            edit?.id === row.id && !edit.isNew ? (
              <DocEditor
                key={row.id}
                edit={edit}
                busy={busy}
                onChange={(patch) =>
                  setEdit((p) => (p ? { ...p, draft: { ...p.draft, ...patch } } : p))
                }
                onSave={save}
                onCancel={cancelEdit}
              />
            ) : (
              <DocRow
                key={row.id}
                row={row}
                disabled={busy || edit !== null}
                readOnly={readOnly}
                collapseByDefault={collapseDocsByDefault}
                previewLineCount={previewLineCount}
                onEdit={() => startEdit(row)}
                onDelete={() => void remove(row)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function DocRow({
  row,
  disabled,
  readOnly,
  collapseByDefault,
  previewLineCount,
  onEdit,
  onDelete,
}: {
  row: AgentContextDoc;
  disabled: boolean;
  readOnly?: boolean;
  collapseByDefault: boolean;
  previewLineCount: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(!collapseByDefault);
  const preview = useMemo(
    () => buildDocPreview(row.body, previewLineCount),
    [row.body, previewLineCount],
  );
  const collapsible = collapseByDefault;
  const showFullContent = !collapsible || expanded;
  const ToggleIcon = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="border border-border bg-card px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {collapsible && (
              <button
                type="button"
                onClick={() => setExpanded((open) => !open)}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.title}`}
                title={expanded ? 'Collapse' : 'Expand'}
              >
                <ToggleIcon className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
            {collapsible ? (
              <button
                type="button"
                onClick={() => setExpanded((open) => !open)}
                className="min-w-0 truncate text-left font-mono text-xs font-medium text-foreground hover:text-primary"
                aria-expanded={expanded}
              >
                {row.title}
              </button>
            ) : (
              <div className="min-w-0 truncate font-mono text-xs font-medium text-foreground">
                {row.title}
              </div>
            )}
          </div>

          {showFullContent ? (
            <div className="mt-2 text-[12px] text-foreground">
              {row.body ? (
                <Markdown text={row.body} />
              ) : (
                <span className="italic text-muted-foreground">(empty)</span>
              )}
            </div>
          ) : (
            <div className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">
              {preview.text ? (
                <>
                  {preview.text}
                  {preview.truncated && <span className="text-foreground">...</span>}
                </>
              ) : (
                <span className="italic">(empty)</span>
              )}
            </div>
          )}

          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>{row.body.length.toLocaleString()} chars</span>
            <span aria-hidden>·</span>
            {row.readCount > 0 ? (
              <span title="Times an agent run consumed this doc (injected at spawn or fetched at runtime)">
                read {row.readCount}× · last {formatReadAge(row.lastReadAt)}
              </span>
            ) : (
              <span
                className="bg-amber-500/15 px-1 font-medium text-amber-500"
                title="No agent has ever consumed this doc — neither injected at spawn nor fetched at runtime. Consider pruning or pointing the agent at it."
              >
                ⚠ never read
              </span>
            )}
          </div>
        </div>
        {!readOnly && (
          <div className="flex shrink-0 flex-col gap-1">
            <button
              type="button"
              onClick={onEdit}
              disabled={disabled}
              className="border border-border bg-card px-2 py-0.5 text-[10px] hover:bg-muted disabled:opacity-50"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={disabled}
              className="border border-destructive/60 bg-card px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function formatReadAge(lastReadAt: number | null): string {
  if (!lastReadAt) return 'unknown';
  const mins = Math.floor((Date.now() - lastReadAt) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function buildDocPreview(
  body: string,
  maxLines: number,
): { text: string; truncated: boolean } {
  const trimmed = body.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return { text: '', truncated: false };
  const lines = trimmed.split('\n').slice(0, Math.max(1, maxLines));
  const text = lines.join('\n').trimEnd();
  return {
    text,
    truncated: text.length < trimmed.length,
  };
}

function DocEditor({
  edit,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  edit: EditState;
  busy: boolean;
  onChange: (patch: Partial<{ title: string; body: string }>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="border border-primary/60 bg-card px-3 py-2">
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Title
          </span>
          <input
            type="text"
            value={edit.draft.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="doc-title"
            className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Content
          </span>
          <textarea
            value={edit.draft.body}
            onChange={(e) => onChange({ body: e.target.value })}
            rows={10}
            className="w-full border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none focus:border-primary"
          />
        </label>
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="border border-border bg-card px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="border border-primary bg-primary/30 px-2 py-1 text-xs font-medium text-foreground hover:bg-primary/50 disabled:opacity-50"
        >
          {busy ? 'Saving…' : edit.isNew ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
  );
}
