import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { projectsApi, type Project } from '@/features/projects/client';
import { settingsApi, type GlobalSettings } from '@/features/settings/client';
import { AppSettingsModal } from '@/components/AppSettingsModal';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard';
import { SessionSwitcher } from '@/components/SessionSwitcher';
import { HostHealthPill } from '@/features/system/HostHealthPill';
import { Shell } from '@/components/Shell';
import { tabLabel } from '@/components/Tabs';
import { liveEventsApi } from '@/features/live/client';
import {
  readStoredProjectChangedCursor,
  writeStoredProjectChangedCursor,
} from '@/features/live/hooks';
import {
  projectChangedLiveEventFromUnknown,
  scanProjectChangedEvents,
} from '@/features/projects/live-events';
import { useAllProjectsWs } from '@/hooks/use-all-projects-ws';
import { useProjectUnread } from '@/hooks/use-project-unread';
import { useProjectWs } from '@/hooks/use-project-ws';
import { useRichLinkInvalidator } from '@/hooks/use-rich-link-invalidator';
import { useStatuslineSync } from '@/hooks/use-statusline-sync';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useActiveProject } from '@/store/active-project';
import { useAppSettingsModal } from '@/store/app-settings-modal';
import { useOrchestratorTelemetry } from '@/store/orchestrator-telemetry';

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const settingsOpen = useAppSettingsModal((s) => s.open);
  const setSettingsOpen = useAppSettingsModal((s) => s.setOpen);
  const [restartRequired, setRestartRequired] = useState(false);
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const setActiveSlug = useActiveProject((s) => s.setActiveSlug);
  const activeTab = useActiveCenterTab((s) => s.tab);
  const telemetryModel = useOrchestratorTelemetry((s) => s.model);
  const sessionId = useOrchestratorTelemetry((s) => s.sessionId);
  const sessionLabel = useOrchestratorTelemetry((s) => s.sessionLabel);
  const [sessionSwitcherOpen, setSessionSwitcherOpen] = useState(false);
  const sessionBreadcrumbRef = useRef<HTMLButtonElement | null>(null);
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const brandMenuRef = useRef<HTMLDivElement | null>(null);
  const brandButtonRef = useRef<HTMLButtonElement | null>(null);
  const projectChangedScanRef = useRef({ active: 0, background: 0 });
  const projectChangedCursorRef = useRef<string | null>(readStoredProjectChangedCursor());
  const seenProjectChangedLiveIdsRef = useRef<Set<string>>(new Set());
  const replayInFlightRef = useRef(false);

  // Section 10 Phase 2 — first-run onboarding gate. `?onboarding=force` opens
  // it with real preflight; `?onboarding=sim` opens it on a faked blank machine
  // (dev "fresh machine" switch). Otherwise it shows only on a true first run
  // (marker unset + no projects yet).
  const onboardingParam = useMemo(
    () => new URLSearchParams(window.location.search).get('onboarding'),
    [],
  );
  const forceOnboarding = onboardingParam === 'force' || onboardingParam === 'sim';
  const onboardingSimMode = onboardingParam === 'sim';
  const [wizardDismissed, setWizardDismissed] = useState(false);
  const [skipWarning, setSkipWarning] = useState(false);

  useEffect(() => {
    if (!brandMenuOpen) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (brandMenuRef.current?.contains(t)) return;
      if (brandButtonRef.current?.contains(t)) return;
      setBrandMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setBrandMenuOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [brandMenuOpen]);

  // Activity panel open/closed lives in settings_global.activity_panel.
  // `showAllProjects` field still in settings schema (additive — Section 7
  // will re-consume it via the global cross-project bell); the activity
  // panel itself is per-project scoped since Section 6.
  const activityPanelOpen = settings?.activityPanel.open ?? true;

  useEffect(() => {
    void projectsApi.listProjects().then(setProjects).catch(() => setProjects([]));
    void settingsApi.getSettings().then(setSettings).catch(() => {
      /* best-effort — surfaces as gear icon disabled until next load */
    });
  }, []);

  // Apply the persisted fontScale to documentElement so every rem-based UI
  // size scales. The slider in AppSettingsModal updates the same variable
  // live during preview; on Save this useEffect re-syncs from the canonical
  // settings envelope.
  useEffect(() => {
    if (!settings) return;
    document.documentElement.style.setProperty('--font-scale', String(settings.fontScale));
  }, [settings?.fontScale]);

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
    activeProject?.id ?? null,
    (projects?.length ?? 0) > 1,
  );
  const unreadProjectIds = useProjectUnread({
    projects: projects ?? [],
    projectsLoaded: projects !== null,
    activeProjectId: activeProject?.id ?? null,
    activeEvents: ws.events,
    backgroundEvents: backgroundWs.events,
  });
  useRichLinkInvalidator(ws.events);
  useStatuslineSync(activeProject?.id ?? null, ws.events);

  const storeProjectChangedCursor = useCallback((cursor: string | null) => {
    if (!cursor) return;
    projectChangedCursorRef.current = maxCursor(projectChangedCursorRef.current, cursor);
    writeStoredProjectChangedCursor(projectChangedCursorRef.current);
  }, []);

  useEffect(() => {
    const scan = projectChangedScanRef.current;
    const activeStart = ws.events.length < scan.active ? 0 : scan.active;
    const backgroundStart = backgroundWs.events.length < scan.background ? 0 : scan.background;
    const activeResult = scanProjectChangedEvents(
      ws.events,
      activeStart,
      seenProjectChangedLiveIdsRef.current,
    );
    const backgroundResult = scanProjectChangedEvents(
      backgroundWs.events,
      backgroundStart,
      seenProjectChangedLiveIdsRef.current,
    );
    const shouldRefetch =
      activeResult.shouldRefetch || backgroundResult.shouldRefetch;
    storeProjectChangedCursor(maxCursor(activeResult.latestCursor, backgroundResult.latestCursor));
    projectChangedScanRef.current = {
      active: ws.events.length,
      background: backgroundWs.events.length,
    };
    if (!shouldRefetch) return;
    void projectsApi.listProjects().then(setProjects).catch(() => {});
  }, [ws.events, backgroundWs.events, storeProjectChangedCursor]);

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
    setSkipWarning(false);
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

  const skipOnboarding = useCallback(
    (hardDepsMissing: boolean) => {
      setWizardDismissed(true);
      if (hardDepsMissing) setSkipWarning(true);
      if (!onboardingSimMode) {
        void settingsApi.patchSettings({ onboardingCompletedAt: new Date().toISOString() })
          .then((r) => setSettings(r.settings))
          .catch(() => {});
      }
    },
    [onboardingSimMode],
  );

  if (projects === null) {
    return (
      <div
        data-testid="app-loading"
        className="grid h-full place-items-center bg-background text-muted-foreground"
      >
        Loading…
      </div>
    );
  }

  // First-run gate: render the wizard full-screen instead of the Shell.
  const showWizard =
    !wizardDismissed &&
    (forceOnboarding ||
      (settings !== null && settings.onboardingCompletedAt === null && projects.length === 0));
  if (showWizard) {
    return (
      <OnboardingWizard
        simMode={onboardingSimMode}
        initialProjectsFolder={settings?.projectsFolder ?? ''}
        initialDefaultSurface={settings?.defaultOrchestratorSurface ?? 'chat'}
        onProjectsFolderChange={handleProjectsFolderChange}
        onDefaultSurfaceChange={handleDefaultSurfaceChange}
        onComplete={finishOnboarding}
        onSkip={skipOnboarding}
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
            ref={brandButtonRef}
            type="button"
            onClick={() => setBrandMenuOpen((v) => !v)}
            className={`flex h-full w-full items-center gap-2 px-3 text-left hover:bg-muted/50 ${
              brandMenuOpen ? 'bg-muted/50' : ''
            }`}
            aria-haspopup="menu"
            aria-expanded={brandMenuOpen}
            title="App menu"
          >
            <span className="text-sm font-bold uppercase tracking-[0.14em] text-primary">
              caisson
            </span>
            <span className="text-[10px] text-[var(--fg-dim)]">▾</span>
          </button>
        </div>
        <div className="flex flex-1 items-center gap-3 pr-3">
        {activeProject && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="text-foreground">{activeProject.name}</span>
            <span className="text-[var(--fg-dim)]">›</span>
            <span>{tabLabel(activeTab)}</span>
            {sessionLabel && activeTab === 'orchestrator' && (
              <>
                <span className="text-[var(--fg-dim)]">·</span>
                <button
                  ref={sessionBreadcrumbRef}
                  type="button"
                  data-testid="session-switcher-trigger"
                  onClick={() => setSessionSwitcherOpen((v) => !v)}
                  className={`inline-flex items-center gap-1 italic hover:text-accent ${
                    sessionSwitcherOpen ? 'text-accent' : ''
                  }`}
                  title="Switch sessions"
                  aria-expanded={sessionSwitcherOpen}
                  aria-haspopup="menu"
                >
                  <span className="max-w-[260px] truncate">{sessionLabel}</span>
                  <span className="text-[var(--fg-dim)]">▾</span>
                </button>
              </>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-3 text-[10px] uppercase tracking-[0.04em]">
          <HostHealthPill />
          {telemetryModel && (
            <span className="flex items-center gap-1.5" title="Active orchestrator model">
              <span className="text-[var(--fg-dim)]">model</span>
              <span className="text-foreground">{telemetryModel}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
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
      {skipWarning && (
        <div className="flex items-center justify-between gap-3 border-b border-warning/60 bg-warning/10 px-3 py-1.5 text-xs text-warning">
          <span>
            Setup isn't finished — Claude Code or git is still missing, so chats and
            projects won't work until you install them.
          </span>
          <button
            onClick={() => setSkipWarning(false)}
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
          wsEvents={ws.events}
          wsSend={ws.send}
          wsStatus={ws.status}
          wsDiagnostics={ws.diagnostics}
          applySessionTransition={ws.applySessionTransition}
          defaultOrchestratorSurface={settings?.defaultOrchestratorSurface ?? 'chat'}
        />
      </div>
      {sessionSwitcherOpen && activeProject && (
        <SessionSwitcher
          projectId={activeProject.id}
          projectSlug={activeProject.slug}
          activeSessionId={sessionId}
          anchorEl={sessionBreadcrumbRef.current}
          onClose={() => setSessionSwitcherOpen(false)}
          applySessionTransition={ws.applySessionTransition}
        />
      )}
      {brandMenuOpen && (
        <div
          ref={brandMenuRef}
          role="menu"
          style={{ position: 'fixed', top: 32, left: 0, width: 192, zIndex: 50 }}
          className="border border-primary/40 bg-popover py-1 text-popover-foreground shadow-2xl"
        >
          <button
            role="menuitem"
            type="button"
            disabled={!settings}
            onClick={() => {
              setBrandMenuOpen(false);
              setSettingsOpen(true);
            }}
            className="block w-full px-3 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-40"
          >
            App settings…
          </button>
        </div>
      )}
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
    </div>
  );
}

function maxCursor(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Number(b) > Number(a) ? b : a;
}
