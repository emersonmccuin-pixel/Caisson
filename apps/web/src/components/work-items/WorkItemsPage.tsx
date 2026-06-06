// Work page: renders the Areas view directly. Kanban, Table, and Patterns
// sub-tabs are gone (feat/nav-simplify): Patterns is now a top-level nav
// tab; Kanban/Table are retired.

import { useEffect } from 'react';

import type { Project } from '@/features/projects/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useWorkItemsView } from '@/store/work-items-view';
import { AreasTab } from './AreasTab';

interface WorkItemsPageProps {
  project: Project;
  events: WsEnvelope[];
}

export function WorkItemsPage({ project, events }: WorkItemsPageProps) {
  const setAreaFilter = useWorkItemsView((s) => s.setAreaFilter);

  // Reset the (persisted, project-agnostic) Area filter when the active
  // project switches — an area id from another project would otherwise
  // hide everything.
  useEffect(() => {
    setAreaFilter(null);
  }, [project.id, setAreaFilter]);

  return (
    <div className="flex h-full flex-col bg-background">
      <AreasTab project={project} events={events} />
    </div>
  );
}
