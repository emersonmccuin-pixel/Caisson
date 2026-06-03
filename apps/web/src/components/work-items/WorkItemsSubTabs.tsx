// Section 37.1 — sub-tab strip above the Work Items page. Three values:
// Dashboard (default) · Kanban · Table. Visual matches the existing app-level
// TabBar shape (underline-active, lowercase, monospace) but lives one level
// deeper inside the Work Items tab.

import { useWorkItemsView, type WorkItemsSubTab } from '@/store/work-items-view';

const ORDER: readonly WorkItemsSubTab[] = ['dashboard', 'kanban', 'table'] as const;
// FD-19 — the first sub-tab is "Areas" (Area cards; was Slice 010's "Focus").
// Internal key stays 'dashboard' for persisted-state compatibility.
const LABEL: Record<WorkItemsSubTab, string> = {
  dashboard: 'Areas',
  kanban: 'Kanban',
  table: 'Table',
};

interface Props {
  /** Parent can intercept sub-tab changes (e.g. WorkItemsPage clears the
   *  inspector overlay before delegating to the store setter). */
  onBeforeChange?: (next: WorkItemsSubTab) => void;
}

export function WorkItemsSubTabs({ onBeforeChange }: Props = {}) {
  const value = useWorkItemsView((s) => s.activeSubTab);
  const setValue = useWorkItemsView((s) => s.setActiveSubTab);
  const change = onBeforeChange ?? setValue;
  return (
    <div
      className="flex items-stretch gap-1 border-b border-border/30 bg-[var(--surface-1)] px-5"
      style={{ height: 36 }}
    >
      {ORDER.map((t) => {
        const active = value === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => change(t)}
            className={`inline-flex items-center px-3.5 text-[11px] uppercase tracking-[0.08em] transition-colors ${
              active
                ? 'text-primary'
                : 'text-muted-foreground hover:text-accent'
            }`}
            style={{
              borderBottom: `2px solid ${active ? 'var(--primary)' : 'transparent'}`,
            }}
            aria-pressed={active}
          >
            {LABEL[t]}
          </button>
        );
      })}
    </div>
  );
}
