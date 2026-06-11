// Work page: segmented sub-nav — "Focus" · "Areas" (grid) · "Tasks" (Table/Kanban).
// Default = Areas (first-open lands on Areas, not the potentially-empty Focus).
// The Tasks surface has a left Areas filter rail and a Table|Kanban view
// switcher injected into the toolbar's rightSlot.
// Focus (pc-pty-chat-355/390): project-scoped in regular projects; cross-project
// (nested: project → area → items) only in Command.

import { useEffect } from 'react';

import type { Project } from '@/features/projects/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useWorkItemsView } from '@/store/work-items-view';
import { KanbanBoard } from '@/components/KanbanBoard';
import { AreasTab } from './AreasTab';
import { FocusTab } from './FocusTab';
import { WorkItemsTable } from './WorkItemsTable';

interface WorkItemsPageProps {
  project: Project;
  /** All projects — required by the Focus tab for cross-project display. */
  projects: Project[];
  events: WsEnvelope[];
}

export function WorkItemsPage({ project, projects, events }: WorkItemsPageProps) {
  const setAreaFilter = useWorkItemsView((s) => s.setAreaFilter);
  const workView = useWorkItemsView((s) => s.workView);
  const setWorkView = useWorkItemsView((s) => s.setWorkView);
  const taskView = useWorkItemsView((s) => s.taskView);
  const setTaskView = useWorkItemsView((s) => s.setTaskView);

  // Reset area filter when project changes — an id from another project would
  // hide everything.
  useEffect(() => {
    setAreaFilter(null);
  }, [project.id, setAreaFilter]);

  // Table | Kanban segmented toggle injected into the toolbar rightSlot.
  const viewSwitcher = (
    <div className="flex items-center gap-px">
      <button
        type="button"
        onClick={() => setTaskView('table')}
        aria-pressed={taskView === 'table'}
        className={
          'px-2.5 py-1 text-[11px] uppercase tracking-[0.06em] transition-colors ' +
          (taskView === 'table'
            ? 'border border-primary bg-primary/10 text-primary'
            : 'border border-border/30 text-muted-foreground hover:border-border hover:text-accent')
        }
      >
        Table
      </button>
      <button
        type="button"
        onClick={() => setTaskView('kanban')}
        aria-pressed={taskView === 'kanban'}
        className={
          'px-2.5 py-1 text-[11px] uppercase tracking-[0.06em] transition-colors ' +
          (taskView === 'kanban'
            ? 'border border-primary bg-primary/10 text-primary'
            : 'border border-border/30 text-muted-foreground hover:border-border hover:text-accent')
        }
      >
        Kanban
      </button>
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Slim segmented sub-nav */}
      <div
        className="flex shrink-0 items-stretch border-b border-border/20 bg-[var(--surface-1)] px-4"
        style={{ height: 32 }}
      >
        <NavButton active={workView === 'focus'} onClick={() => setWorkView('focus')}>
          Focus
        </NavButton>
        <NavButton active={workView === 'areas'} onClick={() => setWorkView('areas')}>
          Areas
        </NavButton>
        <NavButton active={workView === 'tasks'} onClick={() => setWorkView('tasks')}>
          Tasks
        </NavButton>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {workView === 'tasks' ? (
          taskView === 'kanban' ? (
            <KanbanBoard project={project} events={events} rightSlot={viewSwitcher} />
          ) : (
            <WorkItemsTable project={project} events={events} rightSlot={viewSwitcher} />
          )
        ) : workView === 'focus' ? (
          <FocusTab project={project} projects={projects} />
        ) : (
          <AreasTab project={project} events={events} />
        )}
      </div>
    </div>
  );
}

function NavButton({
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
      aria-pressed={active}
      className={
        'inline-flex items-center px-3 text-[11px] uppercase tracking-[0.08em] transition-colors ' +
        (active ? 'text-primary' : 'text-muted-foreground hover:text-accent')
      }
      style={{ borderBottom: `2px solid ${active ? 'var(--primary)' : 'transparent'}` }}
    >
      {children}
    </button>
  );
}
