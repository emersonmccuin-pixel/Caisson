import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { projectsApi, type Project } from '@/features/projects/client';
import { settingsApi, type GlobalSettings } from '@/features/settings/client';
import { applyFontCssVars } from '@/features/settings/fonts';
import { AppSettingsModal } from '@/components/AppSettingsModal';
import { CommandIntroModal } from '@/components/CommandIntroModal';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { NotesPopover } from '@/components/NotesPopover';
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard';
import { InboxBell } from '@/features/mailbox/InboxBell';
import { useGlobalQuickAdd } from '@/store/global-quick-add';
import { useCommandTaskFocus } from '@/store/command-task-focus';
import { BuildMarker } from '@/features/system/BuildMarker';
import { ClaudeVersionBanner } from '@/features/system/ClaudeVersionBanner';
import { HostHealthBanner } from '@/features/system/HostHealthBanner';
import { Shell } from '@/components/Shell';
import { COMMAND_PROJECT_SLUG } from '@pc/contracts';
import { liveEventsApi } from '@/features/live/client';
import {
  readStoredProjectChangedCursor,
  writeStoredProjectChangedCursor,
} from '@/features/live/hooks';
import { projectChangedLiveEventFromUnknown } from '@/features/projects/live-events';
import { useAllProjectsWs } from '@/hooks/use-all-projects-ws';
import { deriveActiveSessionProjectIds } from '@/hooks/live-session-project-ids';
import { useProjectUnread } from '@/hooks/use-project-unread';
import { useProjectWs } from '@/hooks/use-project-ws';
import { useDing } from '@/hooks/use-ding';
import { useRichLinkInvalidator } from '@/hooks/use-rich-link-invalidator';
import { useStatuslineSync } from '@/hooks/use-statusline-sync';
import { useLiveGlobalSignature, useLiveStore } from '@/store/live-store';
import { useActiveProject } from '@/store/active-project';
import { useAppSettingsModal } from '@/store/app-settings-modal';

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const settingsOpen = useAppSettingsModal((s) => s.open);
  const setSettingsOpen = useAppSettingsModal((s) => s.setOpen);
  const openQuickAdd = useGlobalQuickAdd((s) => s.open);
  const fireCommandTaskFocus = useCommandTaskFocus((s) => s.fire);
  const [restartRequired, setRestartRequired] = useState(false);
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);
  const [notesOpen, setNotesOpen] = useState(false);
  const notesButtonRef = useRef<HTMLButtonElement | null>(null);
  const projectChangedCursorRef = useRef<string | null>(readStoredProjectChangedCursor());
  const seenProjectChangedLiveIdsRef = useRef<Set<string>>(new Set());
  const replayInFlightRef = useRef(false);
  // Tracks whether the cold load has completed, read by the signature-driven
  // refetch effect WITHOUT depping `projects` (depping it would reintroduce the
  // c6288afd object-churn loop).
  const projectsLoadedRef = useRef(false);

  // Section 10 Phase 2 — first-run onboarding gate. `?onboarding=force` opens
  // it with real preflight; `?onboarding=sim` opens it on a faked blank machine
  // (dev "fresh machine" switch). Otherwise, gate is PREREQUISITE-DRIVEN:
  // on every launch we check actual auth + folder state, not a completion marker.
  // This forces users who previously skipped onboarding back through setup when
  // their Claude auth is missing.
  const onboardingParam = useMemo(
    () => new URLSearchParams(window.location.search).get('onboarding'),
    [],
  );
  const forceOnboarding = onboardingParam === 'force' || onboardingParam === 'sim';
  const onboardingSimMode = onboardingParam === 'sim';
  const [wizardDismissed, setWizardDismissed] = useState(false);
  // Boot readiness: null = checking; true = auth ok + folder set; false = wizard needed.
  // Force/sim modes skip the check and always show the wizard.
  const [bootReady, setBootReady] = useState<boolean | null>(
    forceOnboarding || onboardingSimMode ? false : null,
  );
  // Auth banner: shown when the user is inside the app but Claude isn't signed
  // in (e.g. the token expired). Checked once on mount, after onboarding.
  // 'unknown' = not checked yet; 'authed' = fine; 'login-required' = show banner.
  const [appAuthStatus, setAppAuthStatus] = useState<'unknown' | 'authed' | 'login-required'>('unknown');
  const authCheckDoneRef = useRef(false);

  // Activity panel open/closed lives in settings_global.activity_panel.
  // `showAllProjects` field still in settings schema (additive — Section 7
  // will re-consume it via the global cross-project bell); the activity
  // panel itself is per-project scoped since Section 6.
  const activityPanelOpen = settings?.activityPanel.open ?? true;

  useEffect(() => {
    void projectsApi
      .listProjects()
      .then((p) => {
        projectsLoadedRef.current = true;
        setProjects(p);
      })
      .catch(() => {
        projectsLoadedRef.current = true;
        setProjects([]);
      });
    void settingsApi.getSettings().then((s) => {
      setSettings(s);
      // Gate: a user is "set up" only when they've been through the wizard at
      // least once (onboardingCompletedAt) AND the real prerequisites hold
      // (Claude authed + projects folder set). The completion marker is
      // required because the prerequisites alone can be satisfied on a fresh
      // machine without ever seeing the wizard — projectsFolder has a built-in
      // default, and a user who installed Claude Code separately is already
      // authed — which silently skipped onboarding for first-time users.
      if (!forceOnboarding && !onboardingSimMode) {
        const folderOk = (s.projectsFolder ?? '').trim().length > 0;
        const everCompleted = Boolean(s.onboardingCompletedAt);
        // pc-pty-chat-337: on a fresh packaged launch the in-process API may not
        // be ready when this fires, so getPreflight() can THROW. The old catch
        // set bootReady=true (fail OPEN) → onboarding silently SKIPPED on fresh
        // installs. Retry a few times, then FAIL CLOSED: only let a user through
        // on persistent error if there's evidence they already set up (folder +
        // completed marker); otherwise show the wizard (the safe fresh-machine
        // default).
        const tryPreflight = (attempt: number) => {
          void settingsApi.getPreflight()
            .then((p) => { setBootReady(p.auth.status === 'authed' && folderOk && everCompleted); })
            .catch(() => {
              if (attempt < 4) {
                window.setTimeout(() => tryPreflight(attempt + 1), 500);
              } else {
                setBootReady(folderOk && everCompleted);
              }
            });
        };
        tryPreflight(0);
      }
    }).catch(() => {
      // Settings couldn't load at all — do NOT fail open. Leaving bootReady null
      // keeps the wizard showing (the likely fresh-machine case); a returning
      // user re-completing setup is harmless. (Was: setBootReady(true) — the
      // same fail-open class as the preflight bug, pc-pty-chat-337.)
    });
  }, [forceOnboarding, onboardingSimMode]);

  // Check auth status once after onboarding is dismissed (or on load if already
  // completed). Shows a banner if the account isn't signed in — prevents a
  // blank/broken app when the session expires after first-run.
  useEffect(() => {
    if (authCheckDoneRef.current) return;
    if (!settings) return; // wait until settings load
    if (!wizardDismissed && !forceOnboarding) return; // wizard still showing
    if (onboardingSimMode) return; // sim mode — skip real auth check
    authCheckDoneRef.current = true;
    void settingsApi.getPreflight()
      .then((p) => {
        setAppAuthStatus(p.auth.status === 'authed' ? 'authed' : 'login-required');
      })
      .catch(() => {
        // Transient failure — don't surface the banner (API may be starting).
        setAppAuthStatus('authed');
      });
  }, [settings, wizardDismissed, forceOnboarding, onboardingSimMode]);

  // Apply the persisted fontScale to documentElement so every rem-based UI
  // size scales. The slider in AppSettingsModal updates the same variable
  // live during preview; on Save this useEffect re-syncs from the canonical
  // settings envelope.
  useEffect(() => {
    if (!settings) return;
    document.documentElement.style.setProperty('--font-scale', String(settings.fontScale));
  }, [settings?.fontScale]);

  // Apply per-surface font choices. Each of the four --font-* CSS vars is
  // set on documentElement so every surface picks them up immediately.
  // AppSettingsModal live-previews changes before Save via applyFontCssVars.
  useEffect(() => {
    if (!settings?.fonts) return;
    applyFontCssVars(settings.fonts);
  }, [settings?.fonts]);

  // Reconcile activeSlug with the loaded list — pick the first project if the
  // persisted selection no longer exists (e.g. fresh DB or after soft-delete).
  useEffect(() => {
    if (!projects || projects.length === 0) return;
    if (activeSlug && projects.some((p) => p.slug === activeSlug)) return;
    setActiveSlug(projects[0]!.slug);
  }, [projects, activeSlug, setActiveSlug]);

  const activeProject = useMemo(
    () => projects?.find((p) => p.slug === activeSlug) ?? null,
    [projects, activeSlug],
  );

  const ws = useProjectWs(activeProject);
  const backgroundWs = useAllProjectsWs(
    projects ?? [],
    (projects?.length ?? 0) > 1,
  );
  const unreadProjectIds = useProjectUnread({
    projects: projects ?? [],
    projectsLoaded: projects !== null,
    activeProjectId: activeProject?.id ?? null,
    activeEvents: ws.events,
    backgroundEvents: backgroundWs.events,
  });
  const liveSessionProjectIds = useMemo(
    () => deriveActiveSessionProjectIds(ws.events, backgroundWs.events),
    [ws.events, backgroundWs.events],
  );
  useDing({
    unreadProjectIds,
    activeProjectId: activeProject?.id ?? null,
    activeEvents: ws.events,
  });
  useRichLinkInvalidator(activeProject?.id ?? null);
  useStatuslineSync(activeProject?.id ?? null, ws.events);

  // T3.2 — global `project` signature from the identity-keyed live store. Flips
  // ONLY when a real project.changed frame lands (any socket, active or
  // background), never on WS array identity churn. Drives the refetch below.
  const projectSig = useLiveGlobalSignature('project');

  const storeProjectChangedCursor = useCallback((cursor: string | null) => {
    if (!cursor) return;
    projectChangedCursorRef.current = maxCursor(projectChangedCursorRef.current, cursor);
    writeStoredProjectChangedCursor(projectChangedCursorRef.current);
  }, []);

  // T3.2 — refetch the project list off the live store's `project` signature,
  // NOT off WS array identity. Deps are EXACTLY [projectSig] (a stable string):
  // setProjects returning a new array can NOT re-trigger this, which is what
  // removes the c6288afd freeze. `projects` is read via a ref (projectsLoadedRef)
  // on purpose — depping it would reintroduce that loop.
  useEffect(() => {
    if (!projectsLoadedRef.current) return; // skip before the first cold load
    void projectsApi.listProjects().then(setProjects).catch(() => {});
  }, [projectSig]);

  useEffect(() => {
    if (projects === null || replayInFlightRef.current) return;
    replayInFlightRef.current = true;
    const after = projectChangedCursorRef.current ?? undefined;
    void liveEventsApi.listEvents({
        ...(after ? { after } : {}),
        includeGlobal: true,
        type: 'project.changed',
      })
      .then(async (response) => {
        storeProjectChangedCursor(response.nextCursor);
        let shouldRefetch = response.resetRequired === true;
        for (const candidate of response.events) {
          const event = projectChangedLiveEventFromUnknown(candidate);
          if (!event) continue;
          storeProjectChangedCursor(event.cursor);
          if (seenProjectChangedLiveIdsRef.current.has(event.id)) continue;
          seenProjectChangedLiveIdsRef.current.add(event.id);
          shouldRefetch = true;
        }
        if (shouldRefetch) {
          await projectsApi.listProjects().then(setProjects).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => {
        replayInFlightRef.current = false;
      });
  }, [projects !== null, ws.status, backgroundWs.status, storeProjectChangedCursor]);

  // T2.3-C — cold-load seed for the global host-health pill/banner. A fresh
  // reload replays NOTHING over the WS catch-up (the replay route is catch-up-
  // from-cursor, empty without a prior cursor), so the pill was blank until the
  // next host transition. Seed the current state ONCE from the dedicated
  // snapshot endpoint, which returns the latest host-health frame. A later WS
  // frame (version null → last-write-wins) supersedes it. Host-health only this
  // slice (D4); T3.x generalizes.
  // Command intro modal — show once per entry into the Command space when
  // commandIntroDismissed is false. Resets when the user navigates away so it
  // shows again next time (unless permanently dismissed via "Don't show again").
  const [commandIntroVisible, setCommandIntroVisible] = useState(false);
  const commandIntroLastSlugRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      activeSlug === COMMAND_PROJECT_SLUG &&
      commandIntroLastSlugRef.current !== COMMAND_PROJECT_SLUG &&
      settings !== null &&
      !settings.commandIntroDismissed
    ) {
      commandIntroLastSlugRef.current = COMMAND_PROJECT_SLUG;
      setCommandIntroVisible(true);
    } else if (activeSlug !== COMMAND_PROJECT_SLUG) {
      commandIntroLastSlugRef.current = null;
    }
  }, [activeSlug, settings]);

  const hostHealthSeededRef = useRef(false);
  useEffect(() => {
    if (hostHealthSeededRef.current) return;
    hostHealthSeededRef.current = true;
    void liveEventsApi
      .hostHealthSeed()
      .then((response) => {
        if (response.event) useLiveStore.getState().seedEvents([response.event]);
      })
      .catch(() => {});
  }, []);

  const persistActivityPanelSetting = useCallback(
    (patch: { open?: boolean }) => {
      // Optimistic update so the UI doesn't lag behind the PATCH.
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              activityPanel: {
                open: patch.open ?? prev.activityPanel.open,
                showAllProjects: prev.activityPanel.showAllProjects,
              },
            }
          : prev,
      );
      void settingsApi.patchSettings({
          activityPanel: {
            open: patch.open ?? settings?.activityPanel.open ?? true,
            showAllProjects: settings?.activityPanel.showAllProjects ?? false,
          },
        })
        .catch(() => {
          /* best-effort — next save reconciles */
        });
    },
    [settings],
  );

  const handleProjectUpdated = useCallback((next: Project) => {
    setProjects((prev) => (prev ? prev.map((p) => (p.id === next.id ? next : p)) : prev));
  }, []);

  const handleProjectDeleted = useCallback(
    (projectId: string) => {
      setProjects((prev) => {
        if (!prev) return prev;
        const filtered = prev.filter((p) => p.id !== projectId);
        const wasActive = prev.find((p) => p.id === projectId)?.slug === activeSlug;
        if (wasActive) {
          setActiveSlug(filtered[0]?.slug ?? null);
        }
        return filtered;
      });
    },
    [activeSlug, setActiveSlug],
  );

  // 5+.4 (D87) — drag-reorder. Optimistic local reorder, then PATCH; refetch
  // on failure to recover the canonical order.
  const handleProjectReorder = useCallback((orderedIds: string[]) => {
    setProjects((prev) => {
      if (!prev) return prev;
      const byId = new Map(prev.map((p) => [p.id, p] as const));
      const reordered: Project[] = [];
      for (const id of orderedIds) {
        const p = byId.get(id);
        if (p) reordered.push(p);
      }
      // Append any projects the caller didn't include (defensive — keeps the
      // rail from accidentally dropping rows on a partial-list reorder).
      for (const p of prev) if (!orderedIds.includes(p.id)) reordered.push(p);
      return reordered;
    });
    void projectsApi.reorderProjects(orderedIds).then(setProjects).catch(() => {
      void projectsApi.listProjects().then(setProjects).catch(() => {});
    });
  }, []);

  const finishOnboarding = useCallback(() => {
    setWizardDismissed(true);
    setCreateOpen(true);
    if (!onboardingSimMode) {
      void settingsApi.patchSettings({ onboardingCompletedAt: new Date().toISOString() })
        .then((r) => setSettings(r.settings))
        .catch(() => {});
    }
  }, [onboardingSimMode]);

  // Onboarding "projects folder" step persists GlobalSettings.projectsFolder so
  // the first Create-Project (and all future ones) default to it. Real setting,
  // so we persist even in sim mode (the picker browses the real filesystem).
  const handleProjectsFolderChange = useCallback((path: string) => {
    void settingsApi.patchSettings({ projectsFolder: path })
      .then((r) => setSettings(r.settings))
      .catch(() => {});
  }, []);

  const handleDefaultSurfaceChange = useCallback(
    (surface: GlobalSettings['defaultOrchestratorSurface']) => {
      setSettings((prev) =>
        prev ? { ...prev, defaultOrchestratorSurface: surface } : prev,
      );
      void settingsApi.patchSettings({ defaultOrchestratorSurface: surface })
        .then((r) => setSettings(r.settings))
        .catch(() => {});
    },
    [],
  );


  // Wait for both projects and boot readiness to load before rendering.
  // bootReady===null means the preflight check is still in-flight.
  if (projects === null || bootReady === null) {
    return (
      <div
        data-testid="app-loading"
        className="grid h-full place-items-center bg-background text-muted-foreground"
      >
        Loading…
      </div>
    );
  }

  // Show the wizard until it's been completed once AND the prerequisites hold
  // (both folded into bootReady above). Users who never onboarded, or who later
  // lose Claude auth, are caught here on every launch.
  const showWizard = !wizardDismissed && (forceOnboarding || onboardingSimMode || !bootReady);
  if (showWizard) {
    return (
      <OnboardingWizard
        simMode={onboardingSimMode}
        initialProjectsFolder={settings?.projectsFolder ?? ''}
        initialDefaultSurface={settings?.defaultOrchestratorSurface ?? 'chat'}
        onProjectsFolderChange={handleProjectsFolderChange}
        onDefaultSurfaceChange={handleDefaultSurfaceChange}
        onComplete={finishOnboarding}
      />
    );
  }

  return (
    <div
      data-testid="app-shell"
      className="flex h-full flex-col bg-background text-foreground"
    >
      {/* Section 32.1 — slim 32px header. Brand-block (192px) mirrors the
          rail width so the breadcrumb starts at the same x as the center
          column. Right-side keeps the gear + activity toggle. */}
      <header
        className="flex items-center border-b border-border bg-card text-xs"
        style={{ height: 32 }}
      >
        <div className="flex shrink-0 items-center" style={{ width: 192 }}>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            disabled={!settings}
            className="flex h-full w-full items-center gap-2 px-3 text-left hover:bg-muted/50 disabled:opacity-60"
            title="App settings"
          >
            <span className="text-sm font-bold uppercase tracking-[0.14em] text-primary">
              caisson
            </span>
            <span className="text-[10px] text-[var(--fg-dim)]">▾</span>
          </button>
        </div>
        <div className="flex flex-1 items-center gap-3 pr-3">
        <div className="ml-auto flex items-center gap-1">
          {/* pc-pty-chat-333 — per-project notes scratchpad. */}
          {activeProject && (
            <button
              ref={notesButtonRef}
              type="button"
              onClick={() => setNotesOpen((v) => !v)}
              title="Project scratchpad"
              aria-label="Project scratchpad"
              aria-expanded={notesOpen}
              aria-haspopup="true"
              className={`px-2 py-1 text-[11px] uppercase tracking-[0.06em] hover:bg-primary/10 ${
                notesOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Scratchpad
            </button>
          )}
          {/* Slice 2 — global quick-add: always visible when a project is active.
              On Command: expands the Quick Tasks rail panel + focuses its
              inline input (fast path). Secondary "with note" option lives in
              the panel header. On other projects: opens the full capture modal. */}
          {activeProject && (
            <button
              type="button"
              onClick={() => {
                if (activeSlug === COMMAND_PROJECT_SLUG) {
                  // Ensure the activity panel is open so the QuickTasksPanel is mounted.
                  persistActivityPanelSetting({ open: true });
                  fireCommandTaskFocus();
                } else {
                  openQuickAdd();
                }
              }}
              title="Quick-capture a task (+ Task)"
              aria-label="Quick-add task"
              className="px-2 py-1 text-[11px] uppercase tracking-[0.06em] text-primary hover:bg-primary/10"
            >
              + Task
            </button>
          )}
          {/* M8 (FD-7) — cross-project Inbox bell: decisions waiting on the
              human, any project. */}
          <InboxBell
            projectNames={Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]))}
          />
          <button
            onClick={() => persistActivityPanelSetting({ open: !activityPanelOpen })}
            disabled={!settings}
            title={activityPanelOpen ? 'Hide activity panel' : 'Show activity panel'}
            aria-label="Toggle activity panel"
            className={`px-2 py-1 hover:bg-muted hover:text-foreground disabled:opacity-40 ${
              activityPanelOpen ? 'text-muted-foreground' : 'text-foreground'
            }`}
          >
            {activityPanelOpen ? '▸' : '◂'}
          </button>
        </div>
        </div>
      </header>
      {notesOpen && activeProject && (
        <ErrorBoundary label="notes" fallback={null}>
          <NotesPopover
            key={activeProject.id}
            projectId={activeProject.id}
            initialNotes={activeProject.notes ?? null}
            anchorEl={notesButtonRef.current}
            onClose={() => setNotesOpen(false)}
          />
        </ErrorBoundary>
      )}
      <BuildMarker />
      <HostHealthBanner />
      <ClaudeVersionBanner />
      {appAuthStatus === 'login-required' && (
        <div className="flex items-center justify-between gap-3 border-b border-destructive/60 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <span>
            Claude Code isn't signed in — chats and agents won't work until you sign in again.
          </span>
          <a
            href="/?onboarding=force"
            className="text-destructive underline-offset-2 hover:text-foreground hover:underline"
          >
            Open setup
          </a>
        </div>
      )}
      {restartRequired && (
        <div className="flex items-center justify-between gap-3 border-b border-warning/60 bg-warning/10 px-3 py-1.5 text-xs text-warning">
          <span>
            Data-dir change saved — restart the server for it to take effect.
          </span>
          <button
            onClick={() => setRestartRequired(false)}
            className="text-warning hover:text-foreground"
          >
            dismiss
          </button>
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        <Shell
          projects={projects}
          activityPanelOpen={activityPanelOpen}
          onToggleActivityPanelOpen={(next) => persistActivityPanelSetting({ open: next })}
          onCreateProject={() => setCreateOpen(true)}
          onProjectUpdated={handleProjectUpdated}
          onProjectDeleted={handleProjectDeleted}
          onProjectReorder={handleProjectReorder}
          unreadProjectIds={unreadProjectIds}
          liveSessionProjectIds={liveSessionProjectIds}
          wsEvents={ws.events}
          wsSubscribeRawTerminal={ws.subscribeRawTerminal}
          wsAggregates={ws.aggregates}
          sessionChangedNonce={ws.sessionChangedNonce}
          wsSend={ws.send}
          wsStatus={ws.status}
          wsDiagnostics={ws.diagnostics}
          applySessionTransition={ws.applySessionTransition}
          defaultOrchestratorSurface={settings?.defaultOrchestratorSurface ?? 'chat'}
          showCommandSpace={settings?.showCommandSpace ?? true}
        />
      </div>
      {createOpen && (
        <CreateProjectModal
          {...(settings?.projectsFolder ? { projectsFolder: settings.projectsFolder } : {})}
          onClose={() => setCreateOpen(false)}
          onOpenAppSettings={() => {
            setCreateOpen(false);
            setSettingsOpen(true);
          }}
          onCreated={(p) => {
            // 5+.4 (D87) — new projects land at the bottom of the rail,
            // matching the server-side `max(position) + 1` placement so the
            // optimistic update doesn't fight the next refetch.
            setProjects((prev) => (prev ? [...prev, p] : [p]));
            setActiveSlug(p.slug);
            setCreateOpen(false);
          }}
        />
      )}
      {settingsOpen && settings && (
        <AppSettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next, needsRestart) => {
            setSettings(next);
            if (needsRestart) setRestartRequired(true);
            setSettingsOpen(false);
          }}
        />
      )}
      {commandIntroVisible && (
        <CommandIntroModal
          onClose={(dismissed) => {
            setCommandIntroVisible(false);
            if (dismissed) {
              void settingsApi
                .patchSettings({ commandIntroDismissed: true })
                .then((r) => setSettings(r.settings))
                .catch(() => {});
            }
          }}
        />
      )}
    </div>
  );
}

function maxCursor(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Number(b) > Number(a) ? b : a;
}
