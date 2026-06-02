// Create-project modal. Composes FolderBrowserModal + POST /api/fs/probe +
// POST /api/projects. Mode is derived from the probe:
//   - empty folder            → 'init-empty'
//   - has files, no .git      → 'init-in-place'
//   - already a git repo      → refuse (server also refuses)

import { useEffect, useRef, useState } from 'react';

import { filesApi, type FolderProbe } from '@/features/files/client';
import { projectsApi, type Project } from '@/features/projects/client';
import { createProjectModeFromProbe } from '@/features/projects/createMode';
import { FolderBrowserModal } from './FolderBrowserModal';

interface CreateProjectModalProps {
  /** Global Projects folder setting — also the gate root for the picker.
   *  When unset, the Browse button is disabled with a "set it first" link. */
  projectsFolder?: string;
  onClose: () => void;
  onOpenAppSettings: () => void;
  onCreated: (project: Project) => void;
}

type ProbeState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; probe: FolderProbe }
  | { status: 'error'; message: string };

export function CreateProjectModal({
  projectsFolder,
  onClose,
  onOpenAppSettings,
  onCreated,
}: CreateProjectModalProps) {
  const [name, setName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [probeState, setProbeState] = useState<ProbeState>({ status: 'idle' });
  const [browserOpen, setBrowserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const probeReqId = useRef(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !browserOpen) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [browserOpen, onClose]);

  function probe(path: string) {
    setReplaceExisting(false);
    if (!path.trim()) {
      setProbeState({ status: 'idle' });
      return;
    }
    setProbeState({ status: 'checking' });
    const my = ++probeReqId.current;
    filesApi.probeFolder(path)
      .then((p) => {
        if (my !== probeReqId.current) return;
        setProbeState({ status: 'ready', probe: p });
      })
      .catch((e) => {
        if (my !== probeReqId.current) return;
        setProbeState({ status: 'error', message: (e as Error).message });
      });
  }

  function pickFolder(p: string) {
    setBrowserOpen(false);
    setFolderPath(p);
    probe(p);
  }

  // A repo that already carries a Caisson scaffold is normally refused; the
  // re-adopt checkbox lets the user replace it and attach fresh.
  const blockedByExistingScaffold =
    probeState.status === 'ready' &&
    probeState.probe.isGitRepo &&
    probeState.probe.hasPcScaffold;
  const baseMode = probeState.status === 'ready'
    ? createProjectModeFromProbe(probeState.probe)
    : null;
  const mode =
    baseMode ?? (blockedByExistingScaffold && replaceExisting ? 'attach-to-git' : null);
  const canCreate =
    !busy && name.trim().length > 0 && mode !== null;

  async function submit() {
    if (!canCreate || mode === null) return;
    setBusy(true);
    setErr(null);
    try {
      const project = await projectsApi.createProject({
        name: name.trim(),
        folder_path: folderPath,
        mode,
        ...(replaceExisting ? { replace_existing: true } : {}),
      });
      onCreated(project);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 grid place-items-center bg-black/40"
        onClick={onClose}
      >
        <div
          className="flex w-[520px] flex-col border border-border bg-card text-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold">Create project</h2>
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
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
            className="flex flex-col gap-3 px-4 py-4"
          >
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My project"
                className="bg-muted px-2 py-1 text-sm"
              />
            </label>

            <div className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Folder</span>
              {projectsFolder ? (
                <p className="text-[11px] text-muted-foreground">
                  Inside your Projects folder:{' '}
                  <code className="bg-muted px-1 font-mono">{projectsFolder}</code>
                </p>
              ) : (
                <p className="text-[11px] text-warning">
                  No Projects folder set yet.{' '}
                  <button
                    type="button"
                    onClick={onOpenAppSettings}
                    className="underline hover:text-foreground"
                  >
                    Open App Settings
                  </button>{' '}
                  to choose where projects live before creating one.
                </p>
              )}
              <div className="flex items-stretch gap-1">
                <button
                  type="button"
                  onClick={() => setBrowserOpen(true)}
                  disabled={!projectsFolder}
                  className="border border-border bg-card px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                >
                  Browse…
                </button>
                <code className="flex-1 truncate border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">
                  {folderPath || (
                    <span className="text-muted-foreground">No folder selected</span>
                  )}
                </code>
              </div>
              <ProbePreview state={probeState} />
              {blockedByExistingScaffold && (
                <label className="mt-1 flex items-start gap-2 border border-warning/50 bg-warning/10 px-2 py-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={replaceExisting}
                    onChange={(e) => setReplaceExisting(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Replace the existing Caisson setup and re-adopt this repo. This deletes
                    the current <code className="bg-muted px-1">.project-companion/</code>{' '}
                    folder and starts fresh. Your code and git history are untouched.
                  </span>
                </label>
              )}
            </div>

            {err && <div className="text-xs text-destructive">{err}</div>}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="border border-border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canCreate}
                className="bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      </div>
      {browserOpen && projectsFolder && (
        <FolderBrowserModal
          gateRoot={projectsFolder}
          initialPath={folderPath || projectsFolder}
          onCancel={() => setBrowserOpen(false)}
          onSelect={pickFolder}
        />
      )}
    </>
  );
}

function ProbePreview({ state }: { state: ProbeState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'checking') {
    return <div className="text-xs text-muted-foreground">Checking…</div>;
  }
  if (state.status === 'error') {
    return <div className="text-xs text-destructive">{state.message}</div>;
  }
  const { probe } = state;
  if (!probe.exists) {
    return <div className="text-xs text-destructive">Folder does not exist.</div>;
  }
  if (!probe.isDirectory) {
    return <div className="text-xs text-destructive">Path is not a directory.</div>;
  }
  if (probe.isGitRepo) {
    if (probe.hasPcScaffold) {
      return (
        <div className="text-xs text-warning">
          This repo is already set up with Caisson (a{' '}
          <code className="bg-muted px-1">.project-companion/</code> folder exists).
          Check the box below to replace it and re-adopt.
        </div>
      );
    }
    return (
      <div className="text-xs text-success">
        Existing git repo — will add the Caisson scaffold as one new
        commit. Your code + history stay untouched.
      </div>
    );
  }
  if (!probe.hasFiles) {
    return (
      <div className="text-xs text-success">
        Empty folder — will git init here and commit the scaffold.
      </div>
    );
  }
  return (
    <div className="text-xs text-warning">
      {probe.fileCount} existing {probe.fileCount === 1 ? 'entry' : 'entries'}, no .git
      — will commit as <code className="bg-muted px-1">Initial import</code> then add
      scaffold.
    </div>
  );
}
