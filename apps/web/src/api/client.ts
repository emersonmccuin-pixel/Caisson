import { agentsApi } from '@/features/agents/client';
import { agentRunsApi } from '@/features/agent-runs/client';
import { filesApi } from '@/features/files/client';
import { projectContextApi } from '@/features/project-context/client';
import { projectsApi } from '@/features/projects/client';
import { runtimeApi } from '@/features/runtime/client';
import { settingsApi } from '@/features/settings/client';
import { transientSessionsApi } from '@/features/transient-sessions/client';
import { workItemsApi } from '@/features/work-items/client';
import { workflowsApi } from '@/features/workflows/client';

export * from '@/features/agents/client';
export * from '@/features/agent-runs/client';
export * from '@/features/files/client';
export * from '@/features/project-context/client';
export * from '@/features/projects/client';
export * from '@/features/runtime/client';
export * from '@/features/settings/client';
export * from '@/features/transient-sessions/client';
export * from '@/features/work-items/client';
export * from '@/features/workflows/client';

export const api = {
  ...projectsApi,
  ...filesApi,
  ...workItemsApi,
  ...settingsApi,
  ...runtimeApi,
  ...transientSessionsApi,
  ...projectContextApi,
  ...workflowsApi,
  ...agentRunsApi,
  ...agentsApi,
};
