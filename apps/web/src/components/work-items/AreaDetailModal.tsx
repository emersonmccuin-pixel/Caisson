// Slice 2 — Area detail modal. Shows:
//  • Area description (summary)
//  • Context docs attached to this area (via Slice-1 routes) — with inline add/edit
//  • Open work items only (status = pending/blocked/etc., not done/cancelled/archived)
//  • Create-a-task-in-place (title only, defaults to intake stage + this area)
//
// Live refresh: re-fetches docs on `context-doc` live-event frames for this area.
// Explicit close only — no backdrop/Escape (house rule; modals host hard-to-redo work).

import { useEffect, useRef, useState } from 'react';

import type { Area } from '@/features/areas/client';
import type { Project, Stage } from '@/features/projects/client';
import { contextDocsApi, type ContextDoc } from '@/features/context-docs/client';
import { workItemsApi } from '@/features/work-items/client';
import type { WorkItem } from '@/features/work-items/client';
import { WORK_ITEM_STATUS_DOT_CLASS, WORK_ITEM_STATUS_LABEL } from '@/features/work-items/status';
import { useLiveEntitySignature } from '@/store/live-store';
import { useChatWorkItemModal } from '@/store/chat-work-item-modal';
import { useGlobalQuickAdd } from '@/store/global-quick-add';
import { AreaEditModal } from './AreaEditModal';

/** Statuses that count as "open" for display in the area detail. */
function isOpenStatus(status: WorkItem['status']): boolean {
  return status !== 'complete' && status !== 'cancelled' && status !== 'archived';
}

/** Find the intake (isNew) stage; fall back to the first stage. */
function intakeStageId(stages: Stage[]): string {
  return stages.find((s) => s.isNew)?.id ?? stages[0]?.id ?? 'draft';
}

interface Props {
  project: Project;
  area: Area;
  /** All work items in the project — filtered internally to open area members. */
  workItems: WorkItem[];
  openCount: number;
  doneCount: number;
  onClose: () => void;
  /** Fired after any successful mutation (save / delete) in the edit modal. */
  onChanged: () => void;
}

export function AreaDetailModal({
  project,
  area,
  workItems,
  openCount,
  doneCount,
  onClose,
  onChanged,
}: Props) {
  const [editing, setEditing] = useState(false);
  const openWorkItem = useChatWorkItemModal((s) => s.open);
  const openQuickAdd = useGlobalQuickAdd((s) => s.open);

  // Open members only.
  const openMembers = workItems.filter(
    (wi) => wi.areaId === area.id && isOpenStatus(wi.status),
  );

  // ── Context docs ────────────────────────────────────────────────────────────
  const [docs, setDocs] = useState<ContextDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsErr, setDocsErr] = useState<string | null>(null);

  const fetchDocs = () => {
    setDocsLoading(true);
    setDocsErr(null);
    contextDocsApi
      .list(project.id, 'area', area.id)
      .then((d) => {
        setDocs(d);
        setDocsLoading(false);
      })
      .catch((e: unknown) => {
        setDocsErr((e as Error).message);
        setDocsLoading(false);
      });
  };

  useEffect(() => {
    fetchDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, area.id]);

  // Live refresh on context-doc changed events.
  const contextDocSig = useLiveEntitySignature('context-doc', project.id);
  const prevSig = useRef(contextDocSig);
  useEffect(() => {
    if (prevSig.current !== contextDocSig) {
      prevSig.current = contextDocSig;
      fetchDocs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextDocSig]);

  // ── Add doc ─────────────────────────────────────────────────────────────────
  const [addingDoc, setAddingDoc] = useState(false);
  const [docTitle, setDocTitle] = useState('');
  const [docBody, setDocBody] = useState('');
  const [docBusy, setDocBusy] = useState(false);

  async function submitDoc() {
    const t = docTitle.trim();
    if (!t || docBusy) return;
    setDocBusy(true);
    try {
      await contextDocsApi.create(project.id, {
        scope: 'area',
        scopeId: area.id,
        title: t,
        ...(docBody.trim() ? { body: docBody.trim() } : {}),
      });
      setDocTitle('');
      setDocBody('');
      setAddingDoc(false);
      fetchDocs();
    } catch (e: unknown) {
      setDocsErr((e as Error).message);
    } finally {
      setDocBusy(false);
    }
  }

  // ── Edit doc ─────────────────────────────────────────────────────────────────
  const [editingDocId, setEditingDocId] = useState<string | null>(null);
  const [editDocTitle, setEditDocTitle] = useState('');
  const [editDocBody, setEditDocBody] = useState('');
  const [editDocBusy, setEditDocBusy] = useState(false);

  function startEditDoc(doc: ContextDoc) {
    setEditingDocId(doc.id);
    setEditDocTitle(doc.title);
    setEditDocBody(doc.body);
  }

  async function saveDoc() {
    if (!editingDocId || editDocBusy) return;
    setEditDocBusy(true);
    try {
      await contextDocsApi.update(project.id, editingDocId, {
        title: editDocTitle.trim() || undefined,
        body: editDocBody,
      });
      setEditingDocId(null);
      fetchDocs();
    } catch (e: unknown) {
      setDocsErr((e as Error).message);
    } finally {
      setEditDocBusy(false);
    }
  }

  // ── Create task in-place ─────────────────────────────────────────────────────
  const [creatingTask, setCreatingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskErr, setTaskErr] = useState<string | null>(null);

  async function submitTask() {
    const t = newTaskTitle.trim();
    if (!t || taskBusy) return;
    setTaskBusy(true);
    setTaskErr(null);
    try {
      await workItemsApi.createWorkItem(project.id, t, intakeStageId(project.stages), {
        areaId: area.id,
      });
      setNewTaskTitle('');
      setCreatingTask(false);
      onChanged();
    } catch (e: unknown) {
      setTaskErr((e as Error).message);
    } finally {
      setTaskBusy(false);
    }
  }

  function handleEditChanged() {
    onChanged();
    setEditing(false);
    onClose();
  }

  return (
    <>
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/40">
        <div className="flex max-h-[85vh] w-full max-w-2xl flex-col border border-border bg-card text-foreground">
          {/* Header */}
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
                onClick={() => openQuickAdd(area.id, area.name)}
                className="border border-primary/60 px-2.5 py-1 text-[11px] uppercase tracking-[0.06em] text-primary hover:bg-primary/10"
                title="Quick-capture a task into this area"
              >
                + Task
              </button>
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

          <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
            {/* Description */}
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--fg-dim)]">
                Description
              </div>
              {area.summary ? (
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
                  {area.summary}
                </p>
              ) : (
                <p className="text-[13px] italic text-[var(--fg-dim)]">
                  No description yet — use Edit to add one.
                </p>
              )}
            </div>

            {/* Context docs */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--fg-dim)]">
                  Context docs {docsLoading ? '…' : `· ${docs.length}`}
                </div>
                {!addingDoc && (
                  <button
                    type="button"
                    onClick={() => setAddingDoc(true)}
                    className="text-[10px] text-primary hover:underline"
                  >
                    + Add doc
                  </button>
                )}
              </div>

              {docsErr && (
                <div className="mb-2 border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                  {docsErr}{' '}
                  <button
                    type="button"
                    onClick={() => setDocsErr(null)}
                    className="underline"
                  >
                    dismiss
                  </button>
                </div>
              )}

              {addingDoc && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitDoc();
                  }}
                  className="mb-3 flex flex-col gap-2 border border-primary/30 bg-primary/[0.03] p-3"
                >
                  <input
                    autoFocus
                    type="text"
                    value={docTitle}
                    onChange={(e) => setDocTitle(e.target.value)}
                    placeholder="Doc title"
                    className="w-full border border-border bg-background px-2 py-1 text-[12px]"
                  />
                  <textarea
                    value={docBody}
                    onChange={(e) => setDocBody(e.target.value)}
                    placeholder="Body (optional)"
                    rows={3}
                    className="w-full resize-y border border-border bg-background px-2 py-1 font-mono text-[11px] leading-relaxed"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={docBusy || !docTitle.trim()}
                      className="border border-primary bg-primary/10 px-3 py-0.5 text-[11px] uppercase tracking-[0.06em] text-primary hover:bg-primary/20 disabled:opacity-50"
                    >
                      {docBusy ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAddingDoc(false);
                        setDocTitle('');
                        setDocBody('');
                      }}
                      className="px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {docs.length === 0 && !addingDoc && !docsLoading && (
                <div className="border border-dashed border-border/30 px-3 py-4 text-center text-[12px] text-muted-foreground">
                  No context docs yet. Add one to give agents knowledge about this area.
                </div>
              )}

              {docs.map((doc) => (
                <div
                  key={doc.id}
                  className="mb-2 border border-border/40 p-3"
                >
                  {editingDocId === doc.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveDoc();
                      }}
                      className="flex flex-col gap-2"
                    >
                      <input
                        autoFocus
                        type="text"
                        value={editDocTitle}
                        onChange={(e) => setEditDocTitle(e.target.value)}
                        className="w-full border border-border bg-background px-2 py-1 text-[12px]"
                      />
                      <textarea
                        value={editDocBody}
                        onChange={(e) => setEditDocBody(e.target.value)}
                        rows={4}
                        className="w-full resize-y border border-border bg-background px-2 py-1 font-mono text-[11px] leading-relaxed"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="submit"
                          disabled={editDocBusy}
                          className="border border-primary bg-primary/10 px-3 py-0.5 text-[11px] uppercase tracking-[0.06em] text-primary hover:bg-primary/20 disabled:opacity-50"
                        >
                          {editDocBusy ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingDocId(null)}
                          className="px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-[12px] font-medium text-foreground">
                          {doc.title}
                        </span>
                        <button
                          type="button"
                          onClick={() => startEditDoc(doc)}
                          className="shrink-0 text-[10px] text-muted-foreground hover:text-primary"
                        >
                          edit
                        </button>
                      </div>
                      {doc.body ? (
                        <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                          {doc.body}
                        </p>
                      ) : (
                        <p className="text-[11px] italic text-[var(--fg-dim)]">No body.</p>
                      )}
                      <p className="mt-1 text-[10px] text-[var(--fg-dim)]">
                        by {doc.author} · {new Date(doc.updatedAt).toLocaleDateString()}
                      </p>
                    </>
                  )}
                </div>
              ))}
            </div>

            {/* Open tasks */}
            <div>
              <div className="mb-2 text-[10px] uppercase tracking-[0.08em] text-[var(--fg-dim)]">
                Open tasks · {openMembers.length}
              </div>

              {openMembers.length === 0 ? (
                <div className="border border-dashed border-border/30 px-3 py-5 text-center text-[12px] text-muted-foreground">
                  No open tasks in this area.
                </div>
              ) : (
                <div className="flex flex-col border border-border/40">
                  {openMembers.map((wi) => (
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

              {/* Create task in-place */}
              <div className="mt-2">
                {creatingTask ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submitTask();
                    }}
                    className="flex flex-col gap-2"
                  >
                    <input
                      autoFocus
                      type="text"
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                      placeholder="Task title — Enter to create"
                      className="w-full border border-border bg-background px-2 py-1 text-[12px]"
                    />
                    {taskErr && (
                      <div className="text-[11px] text-destructive">{taskErr}</div>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={taskBusy || !newTaskTitle.trim()}
                        className="border border-primary bg-primary/10 px-3 py-0.5 text-[11px] uppercase tracking-[0.06em] text-primary hover:bg-primary/20 disabled:opacity-50"
                      >
                        {taskBusy ? 'Creating…' : 'Create'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCreatingTask(false);
                          setNewTaskTitle('');
                          setTaskErr(null);
                        }}
                        className="px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCreatingTask(true)}
                    className="text-[11px] text-muted-foreground hover:text-primary"
                  >
                    + New task in this area
                  </button>
                )}
              </div>
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
          projectId={project.id}
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
