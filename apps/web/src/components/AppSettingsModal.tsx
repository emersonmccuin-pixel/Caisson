// Q10 — app-wide settings modal.
//
// Tabbed shell modelled on ProjectSettingsPanel: left-side nav + per-tab
// content + per-tab Save (where applicable).
//
// Tabs:
//   - General: projectsFolder, claudeConfigDir, fontScale, etc.
//   - Usage: aggregate cost/session data.
//   - Updates: desktop auto-update.

import { useEffect, useRef, useState } from 'react';

import { runtimeApi } from '@/features/runtime/client';
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  settingsApi,
  type GlobalSettings,
} from '@/features/settings/client';
import { FONT_REGISTRY, applyFontCssVars, fontsForGroup } from '@/features/settings/fonts';
import { useDesktopUpdates } from '@/hooks/use-desktop-updates';
import { useNotificationDingEnabled } from '@/hooks/use-notification-settings';
import { FolderBrowserModal } from './FolderBrowserModal';

type TabId = 'general' | 'usage' | 'updates';

const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'usage', label: 'Usage' },
  { id: 'updates', label: 'Updates' },
];

interface AppSettingsModalProps {
  settings: GlobalSettings;
  onClose: () => void;
  onSaved: (next: GlobalSettings, restartRequired: boolean) => void;
}

export function AppSettingsModal({ settings, onClose, onSaved }: AppSettingsModalProps) {
  const [active, setActive] = useState<TabId>('general');
  const [draft, setDraft] = useState<GlobalSettings>(settings);
  // Section 33 — one picker serves two fields; track which is open.
  const [picker, setPicker] = useState<null | 'projectsFolder' | 'claudeConfigDir'>(null);
  // Section 33 — resolved Claude profile PC is using (effective dir + source).
  const [profile, setProfile] = useState<
    { effective: string; source: 'override' | 'shell' | 'default' } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const initialFontScale = useRef(settings.fontScale);
  const initialFonts = useRef(settings.fonts);

  // Live-preview the font scale as the slider moves. Revert to the persisted
  // value if the user closes without saving.
  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(draft.fontScale));
  }, [draft.fontScale]);

  // Live-preview font choices as the dropdowns change. Revert on cancel.
  useEffect(() => {
    applyFontCssVars(draft.fonts);
  }, [draft.fonts]);

  function cancel() {
    document.documentElement.style.setProperty('--font-scale', String(initialFontScale.current));
    applyFontCssVars(initialFonts.current);
    onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !picker) cancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker]);

  // Section 33 — load the resolved Claude profile for the General-tab read-out.
  const loadProfile = useRef(() => {
    void settingsApi.getClaudeProfile()
      .then((p) => setProfile({ effective: p.effective, source: p.source }))
      .catch(() => {});
  });
  useEffect(() => {
    loadProfile.current();
  }, []);

  const generalDirty =
    draft.projectsFolder !== settings.projectsFolder ||
    draft.fontScale !== settings.fontScale ||
    draft.hideCancelledStage !== settings.hideCancelledStage ||
    draft.remoteControlEnabled !== settings.remoteControlEnabled ||
    draft.showCommandSpace !== settings.showCommandSpace ||
    draft.defaultOrchestratorSurface !== settings.defaultOrchestratorSurface ||
    draft.claudeConfigDir !== settings.claudeConfigDir ||
    draft.agentDispatch.maxConcurrent !== settings.agentDispatch.maxConcurrent ||
    draft.fonts.chat !== settings.fonts.chat ||
    draft.fonts.workItems !== settings.fonts.workItems ||
    draft.fonts.ui !== settings.fonts.ui ||
    draft.fonts.code !== settings.fonts.code;

  async function saveGeneral() {
    if (busy || !generalDirty) return;
    setBusy(true);
    setErr(null);
    try {
      const patch: Partial<GlobalSettings> = {
        projectsFolder: draft.projectsFolder,
        fontScale: draft.fontScale,
        hideCancelledStage: draft.hideCancelledStage,
        remoteControlEnabled: draft.remoteControlEnabled,
        showCommandSpace: draft.showCommandSpace,
        defaultOrchestratorSurface: draft.defaultOrchestratorSurface,
        claudeConfigDir: draft.claudeConfigDir,
        agentDispatch: draft.agentDispatch,
        fonts: draft.fonts,
      };
      const r = await settingsApi.patchSettings(patch);
      initialFontScale.current = r.settings.fontScale;
      initialFonts.current = r.settings.fonts;
      onSaved(r.settings, r.restartRequired);
      // Section 33 — the effective profile may have just changed; refresh the
      // read-out so it reflects the new account immediately.
      loadProfile.current();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        // NO backdrop dismissal per [[feedback_modals_explicit_close_only]] —
        // app settings hosts hard-to-redo work; implicit-close is destructive.
        className="fixed inset-0 z-40 grid place-items-center bg-black/40"
      >
        <div
          className="flex h-[600px] w-[800px] flex-col border border-border bg-card text-foreground"
        >
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold">App settings</h2>
            <button
              onClick={cancel}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              ×
            </button>
          </header>

          <div className="flex min-h-0 flex-1">
            <nav className="flex w-44 shrink-0 flex-col border-r border-border bg-card py-2">
              {TABS.map((t) => {
                const isActive = active === t.id;
                const base = 'block w-full border-l-2 px-3 py-2 text-left text-xs ';
                const state = isActive
                  ? 'border-primary bg-muted text-primary font-medium'
                  : 'border-transparent hover:bg-muted text-foreground/80';
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActive(t.id)}
                    className={base + state}
                  >
                    {t.label}
                  </button>
                );
              })}
            </nav>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex-1 overflow-y-auto px-5 py-4">
                {active === 'general' && (
                  <GeneralTab
                    draft={draft}
                    onDraftChange={(patch) => setDraft((p) => ({ ...p, ...patch }))}
                    profile={profile}
                    onBrowse={() => setPicker('projectsFolder')}
                    onBrowseClaudeConfig={() => setPicker('claudeConfigDir')}
                  />
                )}
                {active === 'usage' && <UsageTab />}
                {active === 'updates' && <UpdatesTab />}
              </div>

              {err && (
                <div className="border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
                  {err}
                </div>
              )}

              <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                {active === 'updates' ? (
                  <button
                    type="button"
                    onClick={cancel}
                    className="border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    Close
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={cancel}
                      disabled={busy}
                      className="border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (active === 'general') void saveGeneral();
                      }}
                      disabled={busy || (active === 'general' && !generalDirty)}
                      className="bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                  </>
                )}
              </footer>
            </div>
          </div>
        </div>
      </div>
      {picker === 'projectsFolder' && (
        <FolderBrowserModal
          initialPath={draft.projectsFolder}
          onCancel={() => setPicker(null)}
          onSelect={(p) => {
            setDraft({ ...draft, projectsFolder: p });
            setPicker(null);
          }}
        />
      )}
      {picker === 'claudeConfigDir' && (
        <FolderBrowserModal
          initialPath={draft.claudeConfigDir ?? profile?.effective ?? ''}
          onCancel={() => setPicker(null)}
          onSelect={(p) => {
            setDraft({ ...draft, claudeConfigDir: p });
            setPicker(null);
          }}
        />
      )}
    </>
  );
}

// ── General tab ───────────────────────────────────────────────────────────

function GeneralTab({
  draft,
  onDraftChange,
  profile,
  onBrowse,
  onBrowseClaudeConfig,
}: {
  draft: GlobalSettings;
  onDraftChange: (patch: Partial<GlobalSettings>) => void;
  profile: { effective: string; source: 'override' | 'shell' | 'default' } | null;
  onBrowse: () => void;
  onBrowseClaudeConfig: () => void;
}) {
  const override = draft.claudeConfigDir;
  const sourceLabel =
    profile?.source === 'override'
      ? 'override'
      : profile?.source === 'shell'
        ? 'inherited from the shell that launched PC'
        : 'default (~/.claude)';
  return (
    <div className="flex flex-col gap-4">
      <FieldRow
        label="Claude account"
        help="Which Claude login PC runs your chats and agents under. Switch this to point PC at a different account's data (e.g. work vs personal) without restarting your shell. Applies to NEW chat sessions — existing chats stay on their current account, so click + New session in a project to switch it over."
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-stretch gap-1">
            <button
              type="button"
              onClick={onBrowseClaudeConfig}
              className="border border-border bg-card px-2 py-1 text-xs text-foreground hover:bg-muted"
            >
              Browse…
            </button>
            <code className="flex-1 truncate border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">
              {override ?? 'Use the account from my shell (default)'}
            </code>
            {override !== null && (
              <button
                type="button"
                onClick={() => onDraftChange({ claudeConfigDir: null })}
                className="border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Clear the override and inherit the account from the shell that launched PC."
              >
                Use shell default
              </button>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {profile ? (
              <>
                PC is currently using{' '}
                <code className="font-mono text-foreground/80">{profile.effective}</code>{' '}
                <span className="text-muted-foreground">({sourceLabel})</span>.
              </>
            ) : (
              'Resolving current account…'
            )}
          </div>
        </div>
      </FieldRow>

      <FieldRow
        label="Projects folder"
        help="Default initial path for the create-project folder picker. Hot-reloadable."
      >
        <div className="flex items-stretch gap-1">
          <button
            type="button"
            onClick={onBrowse}
            className="border border-border bg-card px-2 py-1 text-xs text-foreground hover:bg-muted"
          >
            Browse…
          </button>
          <code className="flex-1 truncate border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">
            {draft.projectsFolder}
          </code>
        </div>
      </FieldRow>

      <FieldRow
        label="Setup"
        help="Re-run the first-time setup wizard (Claude sign-in + projects folder). Use this if the app opened without onboarding, or to re-check your sign-in."
      >
        <button
          type="button"
          onClick={() => {
            window.location.href = '/?onboarding=force';
          }}
          className="self-start border border-border bg-card px-2 py-1 text-xs text-foreground hover:bg-muted"
        >
          Re-run setup…
        </button>
      </FieldRow>

      <FieldRow
        label="Default orchestrator surface"
        help="Choose what new live project sessions open to when there is no session-specific override."
      >
        <div className="inline-flex self-start border border-border bg-background p-0.5">
          {(['chat', 'terminal'] as const).map((surface) => {
            const active = draft.defaultOrchestratorSurface === surface;
            return (
              <button
                key={surface}
                type="button"
                onClick={() => onDraftChange({ defaultOrchestratorSurface: surface })}
                className={
                  'px-3 py-1 text-xs font-medium capitalize ' +
                  (active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground')
                }
              >
                {surface}
              </button>
            );
          })}
        </div>
      </FieldRow>

      <FieldRow
        label="Hide cancelled stage"
        help="When on, the cancelled column is hidden on every project's kanban board. Each project can override this in its own settings."
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.hideCancelledStage}
            onChange={(e) => onDraftChange({ hideCancelledStage: e.target.checked })}
          />
          <span>Hide cancelled by default</span>
        </label>
      </FieldRow>

      <FieldRow
        label="Remote control"
        help="When on, new chat sessions start remote-ready so you can drive them from the Claude phone/web app. Each project can override this, and each session has a live toggle in the chat footer. Requires a paid Claude plan (not an API key)."
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.remoteControlEnabled}
            onChange={(e) => onDraftChange({ remoteControlEnabled: e.target.checked })}
          />
          <span>Enable remote control by default</span>
        </label>
      </FieldRow>

      <FieldRow
        label="Command space"
        help="Command is a cross-project planning space that sits above all your projects — a single chat where you decide what matters across everything you're juggling, star the work to focus on, and capture loose to-dos. It's an advanced surface, so it's hidden by default. Turn it on to show the Command row at the top of the project list. Hiding it never deletes any Command data."
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.showCommandSpace}
            onChange={(e) => onDraftChange({ showCommandSpace: e.target.checked })}
          />
          <span>Show the Command space</span>
        </label>
      </FieldRow>

      <FieldRow
        label="Max agents at once"
        help="How many agents may run at the same time (1–50). Extra dispatches wait in line. Applies immediately on Save — running agents are never interrupted."
      >
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            max={50}
            step={1}
            value={draft.agentDispatch.maxConcurrent}
            onChange={(e) => {
              const n = Math.trunc(Number(e.target.value));
              if (!Number.isFinite(n)) return;
              onDraftChange({
                agentDispatch: {
                  ...draft.agentDispatch,
                  maxConcurrent: Math.max(1, Math.min(50, n)),
                },
              });
            }}
            className="w-20 border border-border bg-background px-2 py-1 text-sm text-foreground"
          />
          <button
            type="button"
            onClick={() =>
              onDraftChange({
                agentDispatch: { ...draft.agentDispatch, maxConcurrent: 5 },
              })
            }
            disabled={draft.agentDispatch.maxConcurrent === 5}
            className="border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            Reset to 5
          </button>
        </div>
      </FieldRow>

      <NotificationDingRow />

      <FieldRow
        label="Font scale"
        help={`Scales every text size in the app. ${Math.round(draft.fontScale * 100)}% — drag to preview, Save to keep.`}
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            step={FONT_SCALE_STEP}
            value={draft.fontScale}
            onChange={(e) => onDraftChange({ fontScale: parseFloat(e.target.value) })}
            className="flex-1 accent-primary"
          />
          <span className="w-12 text-right tabular-nums text-xs text-muted-foreground">
            {Math.round(draft.fontScale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => onDraftChange({ fontScale: 1 })}
            disabled={draft.fontScale === 1}
            className="border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            Reset
          </button>
        </div>
      </FieldRow>

      <AppearanceSection draft={draft} onDraftChange={onDraftChange} />
    </div>
  );
}

// ── Appearance section (inside General tab) ──────────────────────────────────

function AppearanceSection({
  draft,
  onDraftChange,
}: {
  draft: GlobalSettings;
  onDraftChange: (patch: Partial<GlobalSettings>) => void;
}) {
  const fontGroups: {
    key: 'chat' | 'workItems' | 'ui' | 'code';
    label: string;
    help: string;
  }[] = [
    { key: 'chat', label: 'Chat', help: 'Font for orchestrator chat messages and markdown.' },
    { key: 'workItems', label: 'Work Items', help: 'Font for kanban cards, work-item views, and areas.' },
    { key: 'ui', label: 'App chrome', help: 'Font for navigation, labels, buttons, and settings.' },
    { key: 'code', label: 'Code & Terminal', help: 'Font for the terminal, code blocks, and technical badges. Monospace only.' },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
        Appearance
      </div>
      {fontGroups.map(({ key, label, help }) => {
        const eligible = fontsForGroup(key);
        return (
          <FieldRow key={key} label={label} help={help}>
            <select
              value={draft.fonts[key]}
              onChange={(e) =>
                onDraftChange({
                  fonts: {
                    ...draft.fonts,
                    [key]: e.target.value,
                  },
                })
              }
              className="w-full border border-border bg-background px-2 py-1 text-sm text-foreground"
            >
              {eligible.map((fontKey) => (
                <option key={fontKey} value={fontKey}>
                  {FONT_REGISTRY[fontKey].label}
                </option>
              ))}
            </select>
          </FieldRow>
        );
      })}
    </div>
  );
}

// ── Notification ding row (inside General tab) ────────────────────────────

function NotificationDingRow() {
  const [enabled, setEnabled] = useNotificationDingEnabled();
  return (
    <FieldRow
      label="Notification sound"
      help="Play a soft ding when a reply arrives in a project you're not looking at, or when the window is out of focus. Takes effect immediately — no Save needed."
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Enable notification ding</span>
      </label>
    </FieldRow>
  );
}

// ── Usage tab ─────────────────────────────────────────────────────────────

function UsageTab() {
  const [bucket, setBucket] = useState<'day' | 'week' | 'month'>('day');
  const [windowDays, setWindowDays] = useState<number>(30);
  const [rows, setRows] = useState<
    Array<{ bucket: string; costUsd: number; sessions: number }> | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    runtimeApi.getUsageAggregate(bucket, windowDays)
      .then((r) => {
        if (!cancelled) setRows(r.rows);
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bucket, windowDays]);

  const totalCost = (rows ?? []).reduce((acc, r) => acc + r.costUsd, 0);
  const totalSessions = (rows ?? []).reduce((acc, r) => acc + r.sessions, 0);
  const maxCost = (rows ?? []).reduce((m, r) => Math.max(m, r.costUsd), 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        Usage data comes from CC's statusline. Cost reflects what the
        Anthropic API would charge — under a subscription it's an estimate of
        what you'd pay on metered usage, not a real bill. Sessions counted
        once each (latest snapshot wins).
      </div>

      <div className="flex items-end gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Bucket</span>
          <select
            value={bucket}
            onChange={(e) => setBucket(e.target.value as typeof bucket)}
            className="border border-border bg-background px-2 py-1"
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Window</span>
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="border border-border bg-background px-2 py-1"
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>1 year</option>
          </select>
        </label>
        <div className="ml-auto flex flex-col items-end text-right">
          <span className="text-muted-foreground">Window total</span>
          <span className="font-mono text-lg text-foreground">
            ${totalCost.toFixed(2)}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {totalSessions} session{totalSessions === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {err && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {err}
        </div>
      )}

      {loading && (
        <div className="text-xs text-muted-foreground">Loading…</div>
      )}

      {!loading && rows !== null && rows.length === 0 && (
        <div className="border border-dashed border-border bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
          No usage in this window. PC's statusline hook records data once a
          chat session reaches CC's status-line refresh path. Start a chat,
          send a prompt, and the next snapshot will land here.
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>Bucket</span>
            <span>Cost · sessions</span>
          </div>
          {rows.map((r) => {
            const fillPct = maxCost > 0 ? (r.costUsd / maxCost) * 100 : 0;
            return (
              <div key={r.bucket} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between font-mono text-xs">
                  <span className="text-foreground/80">{r.bucket}</span>
                  <span className="text-foreground">
                    ${r.costUsd.toFixed(2)}{' '}
                    <span className="text-muted-foreground">· {r.sessions}</span>
                  </span>
                </div>
                <div className="relative h-1.5 w-full overflow-hidden bg-muted">
                  <div
                    className="absolute inset-y-0 left-0 bg-primary/60"
                    style={{ width: `${fillPct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Updates tab ───────────────────────────────────────────────────────────

function UpdatesTab() {
  const { isDesktop, state, check, download, install } = useDesktopUpdates();
  const [busy, setBusy] = useState(false);

  // Not in the desktop shell at all → updates are a desktop-only concern.
  if (!isDesktop) {
    return (
      <div className="border border-border/60 bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
        Auto-update is part of the installed Caisson desktop app. You're viewing
        PC in a browser, so there's nothing to update here.
      </div>
    );
  }

  // Desktop dev-run: the updater is inert (no signed feed).
  if (state === null || state.status === 'unsupported') {
    return (
      <div className="flex flex-col gap-3">
        <FieldRow label="Version" help="The running build of Caisson.">
          <code className="self-start border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">
            {state?.currentVersion ?? '—'}
          </code>
        </FieldRow>
        <div className="border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Auto-update runs in the packaged app only — this is a development run,
          so checking for updates is disabled.
        </div>
      </div>
    );
  }

  const checking = state.status === 'checking';
  const downloading = state.status === 'downloading';
  const canCheck = !busy && !checking && !downloading;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <FieldRow label="Current version" help="The running build of Caisson.">
        <code className="self-start border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">
          {state.currentVersion}
        </code>
      </FieldRow>

      <div className="flex flex-col gap-2 border border-border bg-card px-3 py-3">
        {state.status === 'available' && (
          <>
            <div className="text-sm text-foreground">
              Version <span className="font-medium">{state.availableVersion}</span> is
              available.
            </div>
            <button
              type="button"
              onClick={() => void run(download)}
              disabled={busy}
              className="self-start bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Download update
            </button>
          </>
        )}

        {downloading && (
          <>
            <div className="text-sm text-foreground">
              Downloading {state.availableVersion}… {state.percent ?? 0}%
            </div>
            <div className="relative h-1.5 w-full overflow-hidden bg-muted">
              <div
                className="absolute inset-y-0 left-0 bg-primary transition-[width]"
                style={{ width: `${state.percent ?? 0}%` }}
              />
            </div>
          </>
        )}

        {state.status === 'downloaded' && (
          <>
            <div className="text-sm text-foreground">
              Version <span className="font-medium">{state.availableVersion}</span> is
              ready. Caisson will restart to finish installing.
            </div>
            <button
              type="button"
              onClick={() => void install()}
              className="self-start bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Restart &amp; install
            </button>
          </>
        )}

        {(state.status === 'idle' ||
          state.status === 'not-available' ||
          state.status === 'checking') && (
          <div className="text-sm text-muted-foreground">
            {checking
              ? 'Checking for updates…'
              : state.status === 'not-available'
                ? "You're on the latest version."
                : 'Check whether a newer build is available.'}
          </div>
        )}

        {state.status === 'error' && (
          <div className="text-sm text-destructive">
            Update check failed: {state.error ?? 'unknown error'}
          </div>
        )}

        {state.status !== 'available' &&
          state.status !== 'downloading' &&
          state.status !== 'downloaded' && (
            <button
              type="button"
              onClick={() => void run(check)}
              disabled={!canCheck}
              className="self-start border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
          )}
      </div>

      {state.checkedAt && (
        <div className="text-xs text-muted-foreground">
          Last checked {new Date(state.checkedAt).toLocaleString()}.
        </div>
      )}
    </div>
  );
}

// ── Shared field row ──────────────────────────────────────────────────────

function FieldRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-sm text-muted-foreground">{label}</div>
      {children}
      {help && <div className="text-xs text-muted-foreground">{help}</div>}
    </div>
  );
}
