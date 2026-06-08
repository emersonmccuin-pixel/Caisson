// LeftRail — Projects list is the canonical view. Sessions mode is reachable
// only via the header SessionSwitcher's "browse all sessions →" link (which
// sets railMode = 'sessions'); a small "‹ projects" back link in the Sessions
// view returns to the project list. 5+P.C: when the center tab is Files,
// rail content overrides to <FilesRail> regardless of railMode.

import type { Project } from '@/features/projects/client';
import type { SessionTransitionResponse } from '@/features/runtime/client';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useRailMode } from '@/store/rail-mode';
import { FilesRail } from './FilesRail';
import { ProjectRail } from './ProjectRail';
import { SessionsRail } from './SessionsRail';

interface LeftRailProps {
  projects: Project[];
  activeProject: Project | null;
  /** T3.1 — session-changed nonce for the sessions rail's lifecycle refetch. */
  sessionChangedNonce: number;
  applySessionTransition: (transition: SessionTransitionResponse) => void;
  onCreateProject: () => void;
  onProjectDeleted: (projectId: string) => void;
  onProjectReorder: (orderedIds: string[]) => void;
  unreadProjectIds: ReadonlySet<string>;
  /** When true, the Command space row is shown at the top of the project rail. */
  showCommandSpace: boolean;
}

export function LeftRail({
  projects,
  activeProject,
  sessionChangedNonce,
  applySessionTransition,
  onCreateProject,
  onProjectDeleted,
  onProjectReorder,
  unreadProjectIds,
  showCommandSpace,
}: LeftRailProps) {
  const mode = useRailMode((s) => s.mode);
  const setMode = useRailMode((s) => s.setMode);
  const centerTab = useActiveCenterTab((s) => s.tab);
  const setCenterTab = useActiveCenterTab((s) => s.setTab);

  if (centerTab === 'files') {
    return (
      <div className="flex h-full flex-col">
        <button
          onClick={() => setCenterTab('orchestrator')}
          className="border-b border-border bg-card px-3 py-2 text-left text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-accent"
          title="Leave files view"
        >
          ‹ projects
        </button>
        <div className="flex-1 overflow-hidden">
          <FilesRail project={activeProject} />
        </div>
      </div>
    );
  }

  if (mode === 'sessions') {
    return (
      <div className="flex h-full flex-col">
        <button
          onClick={() => setMode('projects')}
          className="border-b border-border bg-card px-3 py-2 text-left text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-accent"
          title="Back to projects"
        >
          ‹ projects
        </button>
        <div className="flex-1 overflow-hidden">
          <SessionsRail
            project={activeProject}
            sessionChangedNonce={sessionChangedNonce}
            applySessionTransition={applySessionTransition}
          />
        </div>
      </div>
    );
  }

  return (
    <ProjectRail
      projects={projects}
      onCreateProject={onCreateProject}
      onProjectDeleted={onProjectDeleted}
      onProjectReorder={onProjectReorder}
      unreadProjectIds={unreadProjectIds}
      showCommandSpace={showCommandSpace}
    />
  );
}
