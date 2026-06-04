// S2 / FD-21 — the lean "+ New workflow" dialog. Replaces WorkflowBuilderModal
// (the transient builder-session popup, deleted in P7):
//   1. Chat handoff banner — conversational authoring lives in the orchestrator
//      chat (it interviews + dispatches the workflow-builder specialist).
//   2. Manual create — name → a DISABLED skeleton workflow (valid def, manual
//      trigger, one placeholder step) the caller drops into the YAML tab to
//      fill in. Disabled-by-default so a half-edited skeleton can never fire.

import { useEffect, useRef, useState } from 'react';

import type { Project } from '@/features/projects/client';
import { workflowsApi, type WorkflowRow } from '@/features/workflows/client';
import { ChatHandoffBanner } from './ChatHandoffBanner';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function CreateWorkflowModal({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated: (row: WorkflowRow) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  async function submit() {
    if (busy) return;
    const trimmed = name.trim();
    const slug = slugify(trimmed);
    if (!slug) {
      setError('Name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const row = await workflowsApi.createWorkflowRow({
        def: {
          id: slug,
          name: trimmed,
          description: '',
          disabled: true, // skeleton can't fire until the user finishes + enables it
          triggers: [{ kind: 'manual' }],
          nodes: [
            {
              id: 'step-1',
              kind: 'agent',
              agent: 'researcher',
              task: 'Describe this step — what should the agent do?',
            },
          ],
        },
        projectId: project.id,
        scope: 'project',
        actor: 'user',
        reason: 'manual create (skeleton)',
      });
      onCreated(row);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex w-full max-w-[560px] flex-col border border-border bg-card text-foreground shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">New workflow</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex flex-col gap-4 px-4 py-4">
          <ChatHandoffBanner onNavigate={onClose}>
            You can create a workflow through conversation in chat.
          </ChatHandoffBanner>

          <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or create one manually
            <span className="h-px flex-1 bg-border" />
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Name<span className="ml-1 text-destructive">*</span>
            </span>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder="Review research"
              className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
            />
            <span className="text-[10px] text-muted-foreground">
              Creates a disabled starter workflow you fill in on the YAML tab. Enable it when it's ready.
            </span>
          </label>

          {error && (
            <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
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
            disabled={busy || !name.trim()}
            className="border border-primary bg-primary/30 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-primary/50 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create workflow'}
          </button>
        </footer>
      </div>
    </div>
  );
}
