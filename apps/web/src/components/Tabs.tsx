// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/Tabs.tsx
// Adapted for Caisson: Section 32.1 — hoisted to a full-width
// topbar (rendered above the body grid in Shell); restyled from folder-
// tab to underline-active with hover-revealed ↗ popout affordance.

export const TABS = ['orchestrator', 'work-items', 'agents', 'workflows', 'patterns', 'files'] as const;
/** `project-settings` is reachable via the right-aligned gear, not the main strip. */
export type Tab = (typeof TABS)[number] | 'project-settings';

const LABEL: Record<(typeof TABS)[number], string> = {
  orchestrator: 'chat',
  'work-items': 'work',
  agents: 'agents',
  workflows: 'workflows',
  patterns: 'patterns',
  files: 'files',
};

/** Friendly label for any Tab value (used by App's breadcrumb). */
export function tabLabel(t: Tab): string {
  return t === 'project-settings' ? 'project settings' : LABEL[t];
}

export function TabBar({
  value,
  onChange,
}: {
  value: Tab;
  onChange: (t: Tab) => void;
}) {
  return (
    <div
      className="flex items-stretch gap-0.5 border-b border-border bg-background px-4"
      style={{ height: 40 }}
    >
      {TABS.map((t) => {
        const active = value === t;
        return (
          <button
            key={t}
            onClick={() => onChange(t)}
            className={`group relative inline-flex items-center gap-2 px-4 text-xs uppercase tracking-[0.06em] transition-colors ${
              active
                ? 'text-primary'
                : 'text-muted-foreground hover:text-accent'
            }`}
            style={{
              borderBottom: `2px solid ${active ? 'var(--primary)' : 'transparent'}`,
              background: active ? 'rgba(212, 166, 74, 0.05)' : 'transparent',
            }}
          >
            <span>{LABEL[t]}</span>
            <span
              className="text-[10px] text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100"
              title="Pop out into its own window (coming soon)"
              aria-hidden="true"
            >
              ↗
            </span>
          </button>
        );
      })}
      <span className="flex-1" />
      <button
        onClick={() => onChange('project-settings')}
        title="Project settings"
        aria-label="Project settings"
        className={`inline-flex items-center px-4 text-sm transition-colors ${
          value === 'project-settings'
            ? 'text-primary'
            : 'text-muted-foreground hover:text-accent'
        }`}
        style={{
          borderBottom: `2px solid ${value === 'project-settings' ? 'var(--primary)' : 'transparent'}`,
          background: value === 'project-settings' ? 'rgba(212, 166, 74, 0.05)' : 'transparent',
        }}
      >
        ⚙
      </button>
    </div>
  );
}
