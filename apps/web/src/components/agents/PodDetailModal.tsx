// Section 17d.4 — Pod detail modal shell + Prompt tab.
//
// Modal divergences from WorkItemDetailModal (per [[feedback_modals_explicit_close_only]]):
//   - No backdrop-click dismiss (backdrop is non-interactive).
//   - No Escape-key dismiss.
//   - Explicit X close + Cancel buttons only.
// Unsaved-changes guard runs on close attempts via window.confirm.
//
// Draft state is hoisted to the modal root so tab switches preserve edits.
// In 17d.4 only the Prompt tab is implemented; the other four tabs render
// a "coming in 17d.X" placeholder until they land.

import { useEffect, useMemo, useState } from 'react';

import { agentsApi, type Pod, type PodBundle } from '@/features/agents/client';
import { projectsApi, type Project } from '@/features/projects/client';
import { Markdown } from '@/components/Markdown';
import { ContextTab } from './ContextTab';
import { SecretsTab } from './SecretsTab';
import { SettingsTab } from './SettingsTab';
import { HistoryTab } from './HistoryTab';

type TabId = 'prompt' | 'context' | 'secrets' | 'settings' | 'history' | 'membership';

const BASE_TABS: { id: TabId; label: string }[] = [
  { id: 'prompt', label: 'Prompt' },
  { id: 'context', label: 'Context' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'settings', label: 'Settings' },
  { id: 'history', label: 'History' },
];

const MEMBERSHIP_TAB: { id: TabId; label: string } = { id: 'membership', label: 'Membership' };


interface PodDetailModalProps {
  pod: Pod;
  /** When true: editing UI is inert (pointer-events: none + reduced opacity).
   *  Footer drops Delete/Save/Cancel — only Close remains. A banner explains
   *  that editing lives in Global Settings. Used when the modal is opened
   *  from the project's Built-in section (17d follow-up). */
  readOnly?: boolean;
  onClose: () => void;
  onDeleted: () => void;
}

/** Slice of the pod the Prompt + Settings tabs edit. */
interface ScalarDraft {
  name: string;
  description: string;
  prompt: string;
  model: string;
  effort: string;
  maxTurns: string;
  tools: string;
}

function draftFromPod(pod: Pod): ScalarDraft {
  return {
    name: pod.name,
    description: pod.description ?? '',
    prompt: pod.prompt ?? '',
    model: pod.model ?? '',
    effort: pod.effort ?? '',
    maxTurns: pod.maxTurns !== null ? String(pod.maxTurns) : '',
    tools: pod.tools.join(', '),
  };
}

function isDirty(draft: ScalarDraft, baseline: Pod): boolean {
  const b = draftFromPod(baseline);
  return (
    draft.name !== b.name ||
    draft.description !== b.description ||
    draft.prompt !== b.prompt ||
    draft.model !== b.model ||
    draft.effort !== b.effort ||
    draft.maxTurns !== b.maxTurns ||
    draft.tools !== b.tools
  );
}

export function PodDetailModal({ pod, readOnly, onClose, onDeleted }: PodDetailModalProps) {
  const [tab, setTab] = useState<TabId>('prompt');
  const tabs = readOnly ? BASE_TABS : [...BASE_TABS, MEMBERSHIP_TAB];
  const [baseline, setBaseline] = useState<Pod>(pod);
  const [draft, setDraft] = useState<ScalarDraft>(() => draftFromPod(pod));
  const [bundle, setBundle] = useState<PodBundle | null>(null);
  const [bundleLoading, setBundleLoading] = useState(true);
  const [bundleErr, setBundleErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isStock = baseline.origin === 'stock';

  // When the parent passes us a new (or refreshed) Pod, adopt it. Caller
  // controls when the modal unmounts; we don't trap stale snapshots.
  useEffect(() => {
    if (pod.id === baseline.id && pod.updatedAt === baseline.updatedAt) return;
    setBaseline(pod);
    if (!isDirty(draft, baseline)) {
      setDraft(draftFromPod(pod));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pod]);

  // Load the bundle (context docs + secrets + mcp) once + on baseline-id change.
  useEffect(() => {
    let cancelled = false;
    setBundleLoading(true);
    setBundleErr(null);
    agentsApi.getPod(baseline.id)
      .then((b) => {
        if (!cancelled) {
          setBundle(b);
          setBaseline(b.agent); // pick up fresh memberProjectIds etc.
          setBundleLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setBundleErr((e as Error).message);
          setBundleLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseline.id]);

  /** Re-fetch the bundle and baseline pod after a membership change. */
  function refreshBundleAndBaseline() {
    agentsApi.getPod(baseline.id)
      .then((b) => {
        setBundle(b);
        setBaseline(b.agent);
      })
      .catch((e: unknown) => setBundleErr((e as Error).message));
  }

  const dirty = isDirty(draft, baseline);

  const lastEdited = useMemo(() => {
    const sec = Math.max(0, Math.round((Date.now() - baseline.updatedAt) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}min ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.round(hr / 24)}d ago`;
  }, [baseline.updatedAt]);

  function confirmDiscardIfDirty(): boolean {
    if (!dirty) return true;
    return window.confirm('Discard unsaved changes?');
  }

  function attemptClose() {
    if (confirmDiscardIfDirty()) onClose();
  }

  async function save() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const patch: Parameters<typeof agentsApi.patchPod>[1] = {};
      const b = draftFromPod(baseline);
      if (draft.name !== b.name) {
        const n = draft.name.trim();
        if (!n) {
          setError('Name cannot be empty.');
          setBusy(false);
          return;
        }
        patch.name = n;
      }
      if (draft.description !== b.description) patch.description = draft.description;
      if (draft.prompt !== b.prompt) patch.prompt = draft.prompt;
      if (draft.model !== b.model) patch.model = draft.model.trim() || null;
      if (draft.effort !== b.effort) patch.effort = draft.effort || null;
      if (draft.maxTurns !== b.maxTurns) {
        if (draft.maxTurns.trim() === '') patch.maxTurns = null;
        else {
          const n = Number(draft.maxTurns);
          if (!Number.isInteger(n) || n <= 0) {
            setError('Max turns must be a positive integer.');
            setBusy(false);
            return;
          }
          patch.maxTurns = n;
        }
      }
      if (draft.tools !== b.tools) {
        patch.tools = draft.tools
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      const next = await agentsApi.patchPod(baseline.id, patch);
      setBaseline(next);
      setDraft(draftFromPod(next));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deletePod() {
    if (isStock) {
      window.alert(
        `${baseline.name} is a stock specialist and can't be deleted. Edit the prompt instead.`,
      );
      return;
    }
    const ok = window.confirm(
      `Delete agent "${baseline.name}"?\n\nThe row is soft-deleted; the audit log preserves history.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await agentsApi.deletePod(baseline.id);
      onDeleted();
    } catch (e) {
      const err = e as Error & { kind?: string };
      if (err.kind === 'stock-specialist') {
        window.alert(err.message);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      // NO backdrop onClick — explicit close only per [[feedback_modals_explicit_close_only]].
      className="fixed inset-0 z-40 grid place-items-center bg-black/40"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex h-[80vh] w-full max-w-3xl flex-col border border-border bg-card text-foreground">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-foreground">{baseline.name}</span>
              {readOnly ? (
                <span className="inline-flex items-center bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  built-in · read-only
                </span>
              ) : (
                <>
                  <span className="inline-flex items-center bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {baseline.scope === 'project' ? 'project' : 'global'}
                  </span>
                  {isStock && (
                    <span className="inline-flex items-center bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                      stock
                    </span>
                  )}
                </>
              )}
            </div>
            {baseline.description && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {baseline.description}
              </p>
            )}
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
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={
                'border-b-2 px-3 py-1.5 text-sm transition-colors ' +
                (tab === t.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground')
              }
            >
              {t.label}
            </button>
          ))}
        </nav>

        {readOnly && (
          <div className="border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            Built-in agent — controlled centrally. Prompt and settings are read-only.
          </div>
        )}

        <div
          className={
            'flex-1 overflow-y-auto px-4 py-3 ' +
            (readOnly ? 'pointer-events-none opacity-70' : '')
          }
        >
          {tab === 'prompt' && (
            <PromptTab
              draft={draft}
              lastEdited={lastEdited}
              readOnly={!!readOnly}
              onPromptChange={(v) => setDraft((p) => ({ ...p, prompt: v }))}
              onViewHistory={() => setTab('history')}
            />
          )}
          {tab === 'context' && (
            <ContextTab
              podId={baseline.id}
              bundle={bundle}
              loading={bundleLoading}
              error={bundleErr}
              onChanged={() =>
                agentsApi.getPod(baseline.id)
                  .then(setBundle)
                  .catch((e: unknown) => setBundleErr((e as Error).message))
              }
            />
          )}
          {tab === 'secrets' && (
            <SecretsTab
              podId={baseline.id}
              bundle={bundle}
              loading={bundleLoading}
              error={bundleErr}
              onChanged={() =>
                agentsApi.getPod(baseline.id)
                  .then(setBundle)
                  .catch((e: unknown) => setBundleErr((e as Error).message))
              }
            />
          )}
          {tab === 'settings' && (
            <SettingsTab
              draft={draft}
              bundle={bundle}
              bundleLoading={bundleLoading}
              bundleErr={bundleErr}
              podId={baseline.id}
              projectId={baseline.projectId}
              onDraftChange={(patch) => setDraft((p) => ({ ...p, ...patch }))}
              onBundleChanged={() =>
                agentsApi.getPod(baseline.id)
                  .then(setBundle)
                  .catch((e: unknown) => setBundleErr((e as Error).message))
              }
            />
          )}
          {tab === 'history' && (
            <HistoryTab podId={baseline.id} />
          )}
          {tab === 'membership' && (
            <MembershipPanel
              pod={baseline}
              onChanged={() => refreshBundleAndBaseline()}
            />
          )}
        </div>

        {error && (
          <div className="border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">
              dismiss
            </button>
          </div>
        )}

        <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          {readOnly ? (
            <>
              <div className="text-xs text-muted-foreground">Read-only view.</div>
              <button
                type="button"
                onClick={attemptClose}
                className="border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
              >
                Close
              </button>
            </>
          ) : (
            <>
              <div>
                <button
                  type="button"
                  onClick={deletePod}
                  disabled={busy || isStock}
                  title={
                    isStock
                      ? 'Stock specialists cannot be deleted.'
                      : 'Soft-delete this agent.'
                  }
                  className="border border-destructive/60 bg-card px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={attemptClose}
                  disabled={busy}
                  className="border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={!dirty || busy}
                  className="border border-primary bg-primary/30 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-primary/50 disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

// --- Prompt tab -------------------------------------------------------------

function PromptTab({
  draft,
  lastEdited,
  readOnly,
  onPromptChange,
  onViewHistory,
}: {
  draft: ScalarDraft;
  lastEdited: string;
  readOnly: boolean;
  onPromptChange: (v: string) => void;
  onViewHistory: () => void;
}) {
  // Default to a rendered-markdown view; the Edit toggle flips to the raw
  // textarea. Read-only pods (e.g. stock agents opened from a workflow) are
  // locked to the rendered view.
  const [editing, setEditing] = useState(false);
  const showEditor = editing && !readOnly;
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Last edited {lastEdited}</span>
        <div className="flex items-center gap-3">
          {!readOnly && (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="underline hover:text-foreground"
            >
              {showEditor ? 'Preview' : 'Edit'}
            </button>
          )}
          <button
            type="button"
            onClick={onViewHistory}
            className="underline hover:text-foreground"
          >
            View in history
          </button>
        </div>
      </div>
      {showEditor ? (
        <textarea
          value={draft.prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          className="min-h-[400px] flex-1 border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary"
          placeholder="The system prompt this agent receives at spawn."
        />
      ) : draft.prompt.trim() ? (
        <div className="min-h-[400px] flex-1 overflow-y-auto border border-border bg-background px-3 py-2">
          <Markdown text={draft.prompt} />
        </div>
      ) : (
        <div className="flex min-h-[400px] flex-1 items-center justify-center border border-border bg-background text-xs text-muted-foreground">
          No prompt set.
        </div>
      )}
    </div>
  );
}

// --- Membership tab ---------------------------------------------------------

function MembershipPanel({
  pod,
  onChanged,
}: {
  pod: Pod;
  onChanged: () => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsErr, setProjectsErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedAddId, setSelectedAddId] = useState('');
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [lastProjectNote, setLastProjectNote] = useState(false);

  useEffect(() => {
    let cancelled = false;
    projectsApi.listProjects()
      .then((ps) => { if (!cancelled) setProjects(ps); })
      .catch((e: unknown) => { if (!cancelled) setProjectsErr((e as Error).message); });
    return () => { cancelled = true; };
  }, []);

  const memberIdSet = useMemo(
    () => new Set(pod.memberProjectIds ?? []),
    [pod.memberProjectIds],
  );

  const memberProjects = useMemo(
    () => projects?.filter((p) => memberIdSet.has(p.id)) ?? [],
    [projects, memberIdSet],
  );

  const addableProjects = useMemo(
    () => projects?.filter((p) => !memberIdSet.has(p.id)) ?? [],
    [projects, memberIdSet],
  );

  async function handleAdd() {
    if (!selectedAddId || busy) return;
    setActionErr(null);
    setBusy(`add-${selectedAddId}`);
    try {
      await agentsApi.addPodToProject(pod.id, selectedAddId);
      setSelectedAddId('');
      onChanged();
    } catch (e) {
      const err = e as Error & { kind?: string };
      if (err.kind === 'name-collision') {
        setActionErr(
          'An agent with the same name already exists in that project. ' +
          'Rename the existing one first.',
        );
      } else {
        setActionErr(err.message);
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(projectId: string, projectName: string) {
    if (busy) return;
    const ok = window.confirm(
      `Remove "${pod.name}" from "${projectName}"?\n\nThe agent stays in the shared library and can be re-added later.`,
    );
    if (!ok) return;
    setActionErr(null);
    setBusy(`remove-${projectId}`);
    try {
      const { wasLastProject } = await agentsApi.removePodFromProject(pod.id, projectId);
      if (wasLastProject) setLastProjectNote(true);
      onChanged();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!pod.shareable) {
    return (
      <div className="flex flex-col gap-3 py-2">
        <div className="border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          This agent is private to its home project. Use{' '}
          <span className="font-medium text-foreground">Make shareable</span> (in the footer) to
          add it to the shared library — after that it can be attached to other projects.
        </div>
      </div>
    );
  }

  if (projectsErr) {
    return <div className="py-2 text-sm text-destructive">{projectsErr}</div>;
  }

  if (!projects) {
    return (
      <div className="py-4 text-sm text-muted-foreground">Loading projects…</div>
    );
  }

  const memberCount = pod.memberProjectIds?.length ?? 0;

  return (
    <div className="flex flex-col gap-5 py-2">
      {memberCount > 1 && (
        <div className="border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-300">
          Shared agent — edits to the prompt, settings, context docs, or secrets apply to every
          project this agent is attached to.
        </div>
      )}

      {lastProjectNote && (
        <div className="border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          This agent is no longer attached to any project but stays in the shared library.
          <button
            type="button"
            onClick={() => setLastProjectNote(false)}
            className="ml-2 underline"
          >
            ok
          </button>
        </div>
      )}

      <div>
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Member projects ({memberProjects.length})
        </div>
        {memberProjects.length === 0 ? (
          <div className="border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            Not attached to any project. Use "Add to project" below.
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {memberProjects.map((p) => (
              <div
                key={p.id}
                className="grid grid-cols-[1fr_auto] items-center gap-3 border border-border bg-background px-3 py-2"
              >
                <span className="text-sm text-foreground">{p.name}</span>
                <button
                  type="button"
                  onClick={() => void handleRemove(p.id, p.name)}
                  disabled={!!busy}
                  className="border border-destructive/60 bg-card px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  {busy === `remove-${p.id}` ? 'Removing…' : 'Remove'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {addableProjects.length > 0 && (
        <div>
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Add to project
          </div>
          <div className="flex items-center gap-2">
            <select
              value={selectedAddId}
              onChange={(e) => setSelectedAddId(e.target.value)}
              disabled={!!busy}
              className="flex-1 border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
            >
              <option value="">— select a project —</option>
              {addableProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={!selectedAddId || !!busy}
              className="border border-primary bg-primary/30 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-primary/50 disabled:opacity-50"
            >
              {busy?.startsWith('add-') ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      )}

      {actionErr && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {actionErr}
          <button
            type="button"
            onClick={() => setActionErr(null)}
            className="ml-2 underline"
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}
