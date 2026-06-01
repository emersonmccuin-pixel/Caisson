// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/Shell.tsx
// Adapted for Caisson: react-resizable-panels v4 API; active-slug
// from zustand store; per-project tab persistence from a tab-store.
//
// v4 sizing gotcha: numeric Panel size props ({18}) are pixels; strings
// without a unit are percentages; "18%" is explicit. Always use the string
// form for percent-based layouts or you get pixel constraints that lock
// the rails to ~20px wide. (Found 2026-05-17 after a UX bug report.)

import { useEffect, useMemo } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import type { Project } from '@/features/projects/client';
import type { OrchestratorSurfacePreference } from '@/features/settings/client';
import type { SessionTransitionResponse } from '@/features/runtime/client';
import type { AgentRunRecord } from '@/features/agent-runs/client';
import type {
  WsDiagnostics,
  WsEnvelope,
  WsOutbound,
  WsStatus,
} from '@/features/runtime/ws-types';
import type { ChatSessionAggregates } from '@/hooks/chat-session-reducer';
import { useProjectAgentRuns } from '@/hooks/use-project-agent-runs';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useActiveProject } from '@/store/active-project';
import { useAgentTranscript } from '@/store/agent-transcript';
import { ActivityPanel } from './ActivityPanel';
import { AgentsList } from './AgentsList';
import { AgentTranscriptModal } from './AgentTranscriptModal';
import { FilesViewer } from './FilesViewer';
import { LeftRail } from './LeftRail';
import { WorkItemsPage } from './work-items/WorkItemsPage';
import { Orchestrator } from './Orchestrator';
import { AttachmentLightboxMount } from './AttachmentLightbox';
import { ChatWorkItemModalMount } from './ChatWorkItemModalMount';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import { RichLinkPreviewCard } from './RichLinkPreviewCard';
import { DevControls } from './DevControls';
import { TabBar } from './Tabs';
import { WorkflowsList } from './WorkflowsList';

// Section 32.1 — TabBar lifted to a topbar but spanning the full width
// confused users. Refinement (Session 31) puts the tab strip back above the
// Center column only; rail + activity panel keep their own headers.

interface ShellProps {
  projects: Project[];
  activityPanelOpen: boolean;
  onToggleActivityPanelOpen: (next: boolean) => void;
  onCreateProject: () => void;
  onProjectUpdated: (next: Project) => void;
  onProjectDeleted: (projectId: string) => void;
  onProjectReorder: (orderedIds: string[]) => void;
  unreadProjectIds: ReadonlySet<string>;
  wsEvents: WsEnvelope[];
  wsAggregates: ChatSessionAggregates;
  wsSend: (msg: WsOutbound) => boolean;
  wsStatus: WsStatus;
  wsDiagnostics: WsDiagnostics;
  applySessionTransition: (transition: SessionTransitionResponse) => void;
  defaultOrchestratorSurface: OrchestratorSurfacePreference;
}

export function Shell({
  projects,
  activityPanelOpen,
  onToggleActivityPanelOpen,
  onCreateProject,
  onProjectUpdated,
  onProjectDeleted,
  onProjectReorder,
  unreadProjectIds,
  wsEvents,
  wsAggregates,
  wsSend,
  wsStatus,
  wsDiagnostics,
  applySessionTransition,
  defaultOrchestratorSurface,
}: ShellProps) {
  const activityRef = usePanelRef();
  const activeSlug = useActiveProject((s) => s.activeSlug);
  const activeProject = projects.find((p) => p.slug === activeSlug) ?? null;

  useEffect(() => {
    const panel = activityRef.current;
    if (!panel) return;
    if (activityPanelOpen) {
      // Use resize(192) instead of expand() so we always land at the correct
      // pixel size regardless of the stale percentage stored in expandToSize.
      // expand() restores to the percentage saved at collapse-time; if the
      // window was resized between collapse and expand that percentage no
      // longer maps to 192px and the panel can land in the midpoint-collapse
      // zone, making expand() a no-op that leaves the panel stuck at 36px.
      if (panel.isCollapsed()) panel.resize(192);
    } else {
      if (!panel.isCollapsed()) panel.collapse();
    }
  }, [activityPanelOpen, activityRef]);

  return (
    <div className="flex h-full flex-col">
      <Group
        orientation="horizontal"
        id="pc-shell-v3"
        className="flex-1 min-h-0"
      >
        <Panel id="rail" defaultSize={192} minSize={192} maxSize={192} groupResizeBehavior="preserve-pixel-size">
          <LeftRail
            projects={projects}
            activeProject={activeProject}
            events={wsEvents}
            applySessionTransition={applySessionTransition}
            onCreateProject={onCreateProject}
            onProjectDeleted={onProjectDeleted}
            onProjectReorder={onProjectReorder}
            unreadProjectIds={unreadProjectIds}
          />
        </Panel>
        <Separator className="w-px bg-border" />
        <Panel id="center" defaultSize="70%" minSize="30%">
          <Center
            activeProject={activeProject}
            projectCount={projects.length}
            wsEvents={wsEvents}
            wsAggregates={wsAggregates}
            wsSend={wsSend}
            wsStatus={wsStatus}
            wsDiagnostics={wsDiagnostics}
            applySessionTransition={applySessionTransition}
            onCreateProject={onCreateProject}
            onProjectUpdated={onProjectUpdated}
            onProjectDeleted={onProjectDeleted}
            defaultOrchestratorSurface={defaultOrchestratorSurface}
          />
        </Panel>
        <Separator className="w-px bg-border" />
        <Panel
          id="activity"
          panelRef={activityRef}
          defaultSize={192}
          minSize={192}
          maxSize={192}
          collapsible
          collapsedSize={36}
          groupResizeBehavior="preserve-pixel-size"
        >
          <ActivityPanel
            project={activeProject}
            events={wsEvents}
            expanded={activityPanelOpen}
            onExpand={() => onToggleActivityPanelOpen(true)}
          />
        </Panel>
        {activeProject && (
          <AgentTranscriptModalMount
            project={activeProject}
            events={wsEvents}
          />
        )}
        {activeProject && (
          <ChatWorkItemModalMount project={activeProject} events={wsEvents} />
        )}
        {activeProject && <AttachmentLightboxMount projectId={activeProject.id} />}
        <RichLinkPreviewCard />
      </Group>
      {import.meta.env.DEV && <DevControls />}
    </div>
  );
}

// 28.5 — single mount above tab content so any surface (Activity Panel,
// AgentDispatchGroupBubble in chat, future surfaces) can open the modal
// via the useAgentTranscript store. Derives the displayed AgentRunRecord
// from events + the project's agent-runs map.
function AgentTranscriptModalMount({
  project,
  events,
}: {
  project: Project;
  events: WsEnvelope[];
}) {
  const openRunId = useAgentTranscript((s) => s.runId);
  const close = useAgentTranscript((s) => s.close);
  const { runs: agentRuns } = useProjectAgentRuns(project, events);

  // Same fallback pattern ActivityPanel used pre-28.5: prefer the latest
  // matching agent-run-changed envelope (carries terminal status even
  // after useProjectAgentRuns drops the row from its map); fall back to
  // the live agentRuns list.
  const transcriptRun = useMemo<AgentRunRecord | null>(() => {
    if (!openRunId) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i];
      if (!env || env.type !== 'agent-run-changed') continue;
      const record = (env as { record?: AgentRunRecord }).record;
      if (record && record.runId === openRunId) return record;
    }
    return agentRuns.find((r) => r.runId === openRunId) ?? null;
  }, [openRunId, events, agentRuns]);

  if (!transcriptRun) return null;
  return <AgentTranscriptModal run={transcriptRun} events={events} onClose={close} />;
}

function Center({
  activeProject,
  projectCount,
  wsEvents,
  wsAggregates,
  wsSend,
  wsStatus,
  wsDiagnostics,
  applySessionTransition,
  onCreateProject,
  onProjectUpdated,
  onProjectDeleted,
  defaultOrchestratorSurface,
}: {
  activeProject: Project | null;
  projectCount: number;
  wsEvents: WsEnvelope[];
  wsAggregates: ChatSessionAggregates;
  wsSend: (msg: WsOutbound) => boolean;
  wsStatus: WsStatus;
  wsDiagnostics: WsDiagnostics;
  applySessionTransition: (transition: SessionTransitionResponse) => void;
  onCreateProject: () => void;
  onProjectUpdated: (next: Project) => void;
  onProjectDeleted: (projectId: string) => void;
  defaultOrchestratorSurface: OrchestratorSurfacePreference;
}) {
  const tab = useActiveCenterTab((s) => s.tab);
  const setTab = useActiveCenterTab((s) => s.setTab);

  if (!activeProject) {
    return <EmptyState projectCount={projectCount} onCreateProject={onCreateProject} />;
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <TabBar value={tab} onChange={setTab} />
      <div className="flex-1 overflow-hidden">
        {tab === 'work-items' ? (
          <WorkItemsPage project={activeProject} events={wsEvents} />
        ) : tab === 'orchestrator' ? (
          <Orchestrator
            project={activeProject}
            events={wsEvents}
            aggregates={wsAggregates}
            send={wsSend}
            wsStatus={wsStatus}
            wsDiagnostics={wsDiagnostics}
            applySessionTransition={applySessionTransition}
            defaultOrchestratorSurface={defaultOrchestratorSurface}
          />
        ) : tab === 'workflows' ? (
          <WorkflowsList project={activeProject} events={wsEvents} send={wsSend} />
        ) : tab === 'agents' ? (
          <AgentsList project={activeProject} events={wsEvents} />
        ) : tab === 'files' ? (
          <FilesViewer project={activeProject} />
        ) : tab === 'project-settings' ? (
          <ProjectSettingsPanel
            project={activeProject}
            events={wsEvents}
            onProjectUpdated={onProjectUpdated}
            onProjectDeleted={onProjectDeleted}
          />
        ) : null}
      </div>
    </div>
  );
}

function EmptyState({
  projectCount,
  onCreateProject,
}: {
  projectCount: number;
  onCreateProject: () => void;
}) {
  // No projects at all → prominent first-run CTA (D85). At least one project
  // but none active (rail unselected) → quieter "pick a project" hint.
  if (projectCount === 0) {
    return (
      <div className="grid h-full place-items-center bg-background">
        <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
          <h1 className="text-2xl font-semibold text-foreground">
            Create your first project
          </h1>
          <p className="text-sm text-muted-foreground">
            Caisson turns a folder on disk into a chat-driven
            workspace: orchestrator conversations, work items, and workflows
            scoped to one project at a time.
          </p>
          <button
            onClick={onCreateProject}
            className="bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Create your first project
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center bg-background text-muted-foreground">
      <div className="text-sm">Select a project from the rail.</div>
    </div>
  );
}
