// "+ Add agent" modal. Two tabs:
//   - From library (default when there are addable shared agents): pick a
//     shareable pod and attach it to THIS project via POST /add-to-project.
//     The agent is NOT copied — edits apply to every project it's attached to.
//   - Manual: the plain inline form (name / description / prompt / model /
//     effort / max-turns / tools / output destination).
//
// Conversational creation moved to the orchestrator chat (S2 / FD-21) — the
// banner below the header hands off. The old Conversational tab (transient
// agent-designer PtySession in the modal) is gone.
//
// Tabs stay MOUNTED across switches (display toggle, not conditional render)
// so half-filled form state survives a toggle to the pool tab and back.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Project } from '@/features/projects/client';
import { agentsApi, type CreatePodInput, type Pod } from '@/features/agents/client';
import { ChatHandoffBanner } from '../ChatHandoffBanner';

interface CreatePodModalProps {
  project: Project;
  onClose: () => void;
  onCreated: (pod: Pod) => void;
}

type TabKey = 'library' | 'manual';

export function CreatePodModal({
  project,
  onClose,
  onCreated,
}: CreatePodModalProps) {
  const [globalPool, setGlobalPool] = useState<Pod[] | null>(null);
  const [poolErr, setPoolErr] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('library');
  const initialTabSet = useRef(false);

  // Shareable non-stock agents not yet attached to this project.
  const pickableGlobals = useMemo(() => {
    if (!globalPool) return [];
    return globalPool.filter(
      (p) =>
        p.shareable === true &&
        p.origin !== 'stock' &&
        !(p.memberProjectIds ?? []).includes(project.id),
    );
  }, [globalPool, project.id]);

  // Load the global pool once on mount.
  useEffect(() => {
    let cancelled = false;
    agentsApi.listPods()
      .then((pods) => {
        if (!cancelled) setGlobalPool(pods);
      })
      .catch((e) => {
        if (!cancelled) setPoolErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Once we know the library is empty, snap to Manual the first time.
  // After that, respect user navigation.
  useEffect(() => {
    if (initialTabSet.current) return;
    if (globalPool === null) return; // pool still loading
    initialTabSet.current = true;
    if (pickableGlobals.length === 0) setTab('manual');
  }, [globalPool, pickableGlobals.length]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex h-[80vh] w-full max-w-[900px] flex-col border border-border bg-card text-foreground shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">Add agent</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="px-4 pt-3">
          <ChatHandoffBanner onNavigate={onClose}>
            You can create an agent through conversation in chat.
          </ChatHandoffBanner>
        </div>

        <TabStrip value={tab} onChange={setTab} />

        <div className="relative min-h-0 flex-1">
          <TabPanel active={tab === 'library'}>
            <GlobalPoolPanel
              project={project}
              pool={globalPool}
              pickable={pickableGlobals}
              error={poolErr}
              onPicked={(newPod) => {
                onCreated(newPod);
              }}
            />
          </TabPanel>

          <TabPanel active={tab === 'manual'}>
            <ManualForm project={project} onClose={onClose} onCreated={onCreated} />
          </TabPanel>
        </div>
      </div>
    </div>
  );
}

// ── Tab strip + panel ─────────────────────────────────────────────────────

function TabStrip({
  value,
  onChange,
}: {
  value: TabKey;
  onChange: (t: TabKey) => void;
}) {
  return (
    <div className="flex shrink-0 items-end gap-1 border-b border-border bg-card px-4 pt-2">
      <TabButton active={value === 'library'} onClick={() => onChange('library')}>
        From library
      </TabButton>
      <TabButton active={value === 'manual'} onClick={() => onChange('manual')}>
        Manual
      </TabButton>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 14px',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        borderStyle: 'solid',
        borderWidth: '1px 1px 0 1px',
        borderRadius: '6px 6px 0 0',
        background: active ? 'rgba(240, 208, 128, 0.30)' : 'rgba(240, 208, 128, 0.075)',
        color: active ? '#f0e4c4' : '#9a8e7a',
        fontWeight: active ? 600 : 400,
        borderColor: active ? 'rgba(240, 208, 128, 0.60)' : 'rgba(240, 208, 128, 0.15)',
        marginBottom: active ? -1 : 0,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function TabPanel({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ display: active ? 'flex' : 'none' }}
      className="absolute inset-0 flex-col"
    >
      {children}
    </div>
  );
}

// ── Library tab — pick + attach ───────────────────────────────────────────

function GlobalPoolPanel({
  project,
  pool,
  pickable,
  error,
  onPicked,
}: {
  project: Project;
  pool: Pod[] | null;
  pickable: Pod[];
  error: string | null;
  onPicked: (pod: Pod) => void;
}) {
  const [addingId, setAddingId] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);

  async function pick(pod: Pod) {
    if (addingId) return;
    setRowErr(null);
    setAddingId(pod.id);
    try {
      await agentsApi.addPodToProject(pod.id, project.id);
      onPicked(pod);
    } catch (e) {
      const err = e as Error & { kind?: string };
      if (err.kind === 'name-collision') {
        setRowErr(
          `An agent named "${pod.name}" already exists in this project. ` +
          `Rename the existing one before adding this shared agent.`,
        );
      } else {
        setRowErr(err.message);
      }
    } finally {
      setAddingId(null);
    }
  }

  if (pool === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading shared library…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (pickable.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <div className="max-w-md text-sm text-muted-foreground">
          No shared agents in the library yet. Design one in{' '}
          <span className="font-medium text-foreground">Manual</span>, then use{' '}
          <span className="font-medium text-foreground">Make shareable</span> to add it to the
          library — after that it can be attached to other projects here.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        These are shared agents — the same agent row is attached to this project.
        Edits apply everywhere it's used.
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-1">
          {pickable.map((pod) => (
            <div
              key={pod.id}
              className="grid grid-cols-[1fr_auto] items-center gap-4 border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{pod.name}</span>
                  {(pod.memberProjectIds?.length ?? 0) > 0 && (
                    <span className="text-[9px] uppercase tracking-wider text-sky-400">
                      {pod.memberProjectIds.length} project{pod.memberProjectIds.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                {pod.description && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {pod.description}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void pick(pod)}
                disabled={addingId !== null}
                className="border border-border bg-card px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
              >
                {addingId === pod.id ? 'Adding…' : 'Add to this project'}
              </button>
            </div>
          ))}
        </div>
        {rowErr && (
          <div className="mt-3 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {rowErr}
            <button onClick={() => setRowErr(null)} className="ml-2 underline">dismiss</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Manual tab — the plain form (lifted from the pre-tabs CreatePodModal) ─

interface FormState {
  name: string;
  description: string;
  prompt: string;
  model: string;
  effort: string;
  maxTurns: string;
  tools: string;
}

const INITIAL: FormState = {
  name: '',
  description: '',
  prompt: '',
  model: '',
  effort: '',
  maxTurns: '',
  tools: '',
};

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function ManualForm({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated: (pod: Pod) => void;
}) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  async function submit() {
    if (busy) return;
    const name = form.name.trim();
    if (!name) {
      setError('Name is required.');
      return;
    }
    const input: CreatePodInput = {
      name,
      scope: 'project',
      projectId: project.id,
    };
    if (form.description.trim()) input.description = form.description.trim();
    if (form.prompt) input.prompt = form.prompt;
    if (form.model.trim()) input.model = form.model.trim();
    if (form.effort) input.effort = form.effort;
    if (form.maxTurns.trim()) {
      const n = Number(form.maxTurns);
      if (!Number.isInteger(n) || n <= 0) {
        setError('Max turns must be a positive integer.');
        return;
      }
      input.maxTurns = n;
    }
    if (form.tools.trim()) {
      input.tools = form.tools
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    setBusy(true);
    setError(null);
    try {
      const pod = await agentsApi.createPod(input);
      onCreated(pod);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-3">
          <Field label="Name" required>
            <input
              ref={nameInputRef}
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="my-agent"
              className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
            />
          </Field>
          <Field label="Description">
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="What this agent does."
              className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
            />
          </Field>
          <Field label="Prompt">
            <textarea
              value={form.prompt}
              onChange={(e) => setForm((p) => ({ ...p, prompt: e.target.value }))}
              rows={8}
              placeholder="You are a..."
              className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Model">
              <input
                type="text"
                value={form.model}
                onChange={(e) => setForm((p) => ({ ...p, model: e.target.value }))}
                placeholder="opus / sonnet / haiku"
                className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
              />
            </Field>
            <Field label="Effort">
              <select
                value={form.effort}
                onChange={(e) => setForm((p) => ({ ...p, effort: e.target.value }))}
                className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
              >
                {EFFORTS.map((opt) => (
                  <option key={opt || '__none__'} value={opt}>
                    {opt || '(default)'}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Max turns">
              <input
                type="number"
                min={1}
                value={form.maxTurns}
                onChange={(e) => setForm((p) => ({ ...p, maxTurns: e.target.value }))}
                placeholder="(no cap)"
                className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
              />
            </Field>
          </div>
          <Field
            label="Tools"
            hint="Comma-separated allowlist. Leave empty to inherit CC defaults."
          >
            <input
              type="text"
              value={form.tools}
              onChange={(e) => setForm((p) => ({ ...p, tools: e.target.value }))}
              placeholder="Read, Glob, Grep, mcp__pc-rig__pc_get_work_item"
              className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
            />
          </Field>
        </div>
        {error && (
          <div className="mt-3 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-card px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !form.name.trim()}
          className="border border-primary bg-primary/30 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-primary/50 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create agent'}
        </button>
      </footer>
    </>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </span>
      {children}
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </label>
  );
}
