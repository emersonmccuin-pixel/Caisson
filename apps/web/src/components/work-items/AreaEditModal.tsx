// FD-19 — Area edit modal. Cards on the Areas tab are display-only; ALL
// editing (name, description, delete) happens here. Explicit close only — no
// backdrop-click / Escape dismissal (modals host hard-to-redo work). Cancel
// confirms discard when the user typed anything.

import { useState } from 'react';

import { AreaConflictError, areasApi, type Area } from '@/features/areas/client';

interface AreaEditModalProps {
  projectId: string;
  area: Area;
  openCount: number;
  doneCount: number;
  onClose: () => void;
  /** Fired after any successful mutation (save / delete) so the tab refetches. */
  onChanged: () => void;
}

export function AreaEditModal({
  projectId,
  area,
  openCount,
  doneCount,
  onClose,
  onChanged,
}: AreaEditModalProps) {
  const [name, setName] = useState(area.name);
  const [summary, setSummary] = useState(area.summary);
  const [version, setVersion] = useState(area.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = name !== area.name || summary !== area.summary;

  function attemptClose() {
    if (busy) return;
    if (dirty) {
      const ok = window.confirm('Discard your changes to this Area?');
      if (!ok) return;
    }
    onClose();
  }

  async function save() {
    const trimmed = name.trim();
    if (busy) return;
    if (!trimmed) {
      setError('Name can’t be empty.');
      return;
    }
    if (!dirty) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await areasApi.patchArea(projectId, area.id, {
        expectedVersion: version,
        ...(trimmed !== area.name ? { name: trimmed } : {}),
        ...(summary !== area.summary ? { summary } : {}),
      });
      onChanged();
      onClose();
    } catch (e) {
      if (e instanceof AreaConflictError) {
        // Someone (often the orchestrator) edited this Area meanwhile — show
        // the live values and let the user re-apply.
        setName(e.current.name);
        setSummary(e.current.summary);
        setVersion(e.current.version);
        setError('This Area changed elsewhere — reloaded the latest values. Re-apply your edits.');
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    const ok = window.confirm(
      `Delete Area "${area.name}"?\n\nItems in this Area move to Uncaptured. No work items are deleted.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await areasApi.deleteArea(projectId, area.id);
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col border border-border bg-card text-foreground">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-base font-semibold">Edit Area</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {openCount} open · {doneCount} done
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
            void save();
          }}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Name
              </label>
              <input
                autoFocus
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-border bg-background px-2 py-1 text-sm"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Description
              </label>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={5}
                placeholder="What belongs in this Area? A good description helps the orchestrator file new work items here automatically."
                className="w-full resize-y border border-border bg-background px-2 py-1 text-xs leading-relaxed"
              />
            </div>

            {error && (
              <div className="border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                {error}
              </div>
            )}
          </div>

          <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="border border-destructive/40 px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
              title="Delete Area — items move to Uncaptured"
            >
              Delete
            </button>
            <div className="flex items-center gap-2">
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
                disabled={busy || !name.trim()}
                className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  );
}
