// Pure constants — no JSX. Importable by tests without a JSX transform.
// TabBar (JSX) lives in Tabs.tsx and imports from here.

export const TABS = ['orchestrator', 'work-items', 'agents', 'workflows', 'files'] as const;
/** `project-settings` is reachable via the right-aligned gear, not the main strip. */
export type Tab = (typeof TABS)[number] | 'project-settings';

/** Tabs shown when the active project is Command.
 *  Command is a cross-project planning surface; Files and Processes (workflows)
 *  add noise without payoff there — chrome only, the underlying engines stay. */
export const COMMAND_TABS: ReadonlyArray<(typeof TABS)[number]> = [
  'orchestrator',
  'work-items',
  'agents',
] as const;
