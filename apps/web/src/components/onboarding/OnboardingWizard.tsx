// Section 10 Phase 2 — first-run onboarding wizard.
//
// A full-screen gate shown before the app Shell when PC is freshly installed:
// it walks a non-technical user from a blank machine (no Claude Code, no git,
// not signed in) to "create your first project". Reads GET /api/preflight to
// know what's missing; drives the official installers + the Claude login.
//
// Dev "fresh machine" switch (2.7): `?onboarding=sim` feeds a fake blank-machine
// preflight and fakes the install/auth actions so every screen is walkable on a
// dev box that already has everything. `?onboarding=force` opens the gate with
// the REAL preflight + REAL actions. See App.tsx for the gate logic.

import { useCallback, useEffect, useRef, useState } from 'react';

import { settingsApi, type OrchestratorSurfacePreference, type PreflightReport } from '@/features/settings/client';
import { FolderBrowserModal } from '@/components/FolderBrowserModal';

type StepId = 'welcome' | 'experience' | 'claude' | 'git' | 'auth' | 'projects' | 'done';

const STEP_ORDER: StepId[] = ['welcome', 'experience', 'claude', 'git', 'auth', 'projects', 'done'];

const STEP_TITLES: Record<StepId, string> = {
  welcome: 'Welcome',
  experience: 'Default view',
  claude: 'Claude Code',
  git: 'Git',
  auth: 'Sign in',
  projects: 'Projects folder',
  done: 'All set',
};

interface OnboardingWizardProps {
  /** Dev sim mode — fake preflight + fake actions so the flow walks on a box
   *  that already has everything. */
  simMode: boolean;
  /** Current default parent dir for new projects (GlobalSettings.projectsFolder). */
  initialProjectsFolder: string;
  initialDefaultSurface: OrchestratorSurfacePreference;
  /** Persist a new projects folder (App PATCHes settings + updates its state). */
  onProjectsFolderChange: (path: string) => void;
  onDefaultSurfaceChange: (surface: OrchestratorSurfacePreference) => void;
  /** Finish: persist the marker + drop into Create-your-first-project. */
  onComplete: () => void;
  /** Skip-for-now escape hatch: persist the marker, close, leave a banner if a
   *  hard dep is still missing (passed back so the app can warn). */
  onSkip: (hardDepsMissing: boolean) => void;
}

/** The blank-machine preflight the sim switch starts from. */
function freshMachinePreflight(): PreflightReport {
  return {
    claude: {
      status: 'not-found',
      path: null,
      source: 'not-found',
      version: null,
      minVersion: '2.0.0',
    },
    auth: { status: 'login-required', note: 'Simulated blank machine.' },
    git: { name: 'git', present: false, version: null, severity: 'hard' },
    soft: [
      { name: 'node', present: false, version: null, severity: 'soft' },
      { name: 'bash', present: false, version: null, severity: 'soft' },
      { name: 'python', present: false, version: null, severity: 'soft' },
    ],
    ok: false,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function OnboardingWizard({
  simMode,
  initialProjectsFolder,
  initialDefaultSurface,
  onProjectsFolderChange,
  onDefaultSurfaceChange,
  onComplete,
  onSkip,
}: OnboardingWizardProps) {
  const [preflight, setPreflight] = useState<PreflightReport | null>(
    simMode ? freshMachinePreflight() : null,
  );
  const [step, setStep] = useState<StepId>('welcome');
  const [busy, setBusy] = useState<null | 'claude' | 'git' | 'auth' | 'refresh'>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [projectsFolder, setProjectsFolder] = useState(initialProjectsFolder);
  const [defaultSurface, setDefaultSurface] =
    useState<OrchestratorSurfacePreference>(initialDefaultSurface);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const simPreflight = useRef<PreflightReport>(freshMachinePreflight());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stop polling + cancel any in-flight login when the wizard unmounts.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (!simMode) void settingsApi.cancelOnboardingLogin().catch(() => {});
    };
  }, [simMode]);

  const refreshPreflight = useCallback(async () => {
    if (simMode) {
      setPreflight({ ...simPreflight.current });
      return simPreflight.current;
    }
    const p = await settingsApi.getPreflight();
    setPreflight(p);
    return p;
  }, [simMode]);

  // Initial real-mode load.
  useEffect(() => {
    if (simMode) return;
    let cancelled = false;
    void settingsApi.getPreflight()
      .then((p) => {
        if (!cancelled) setPreflight(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [simMode]);

  const claudeOk = preflight?.claude.status === 'ok';
  const gitOk = preflight?.git.present === true;
  const authOk = preflight?.auth.status === 'authed';

  const satisfied = useCallback(
    (s: StepId): boolean => {
      switch (s) {
        case 'welcome':
          return step !== 'welcome';
        case 'experience':
          return step !== 'welcome' && step !== 'experience';
        case 'claude':
          return claudeOk;
        case 'git':
          return gitOk;
        case 'auth':
          return authOk;
        case 'projects':
          return projectsFolder.trim().length > 0;
        case 'done':
          return false;
      }
    },
    [claudeOk, gitOk, authOk, projectsFolder, step],
  );

  // ── Install / auth actions ───────────────────────────────────────────────

  async function handleInstallClaude() {
    setBusy('claude');
    setError(null);
    setLog(null);
    try {
      if (simMode) {
        await delay(1400);
        simPreflight.current.claude = {
          status: 'ok',
          path: 'C:\\Users\\you\\.local\\bin\\claude.exe',
          source: 'default-location',
          version: '2.1.150',
          minVersion: '2.0.0',
        };
        setPreflight({ ...simPreflight.current });
        setLog('Simulated: Claude Code installed (2.1.150).');
      } else {
        const r = await settingsApi.installClaude();
        setPreflight(r.preflight);
        setLog(r.log);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleInstallGit() {
    setBusy('git');
    setError(null);
    setLog(null);
    try {
      if (simMode) {
        await delay(1400);
        simPreflight.current.git = { name: 'git', present: true, version: '2.51.0', severity: 'hard' };
        setPreflight({ ...simPreflight.current });
        setLog('Simulated: git installed (2.51.0).');
      } else {
        const r = await settingsApi.installGit();
        setPreflight(r.preflight);
        setLog(r.log);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Auth drive — runs CC's own `claude auth login` (it opens the browser +
  // writes its own credentials), then polls `claude auth status` for success.
  async function handleSignIn() {
    setBusy('auth');
    setError(null);
    setLoginUrl(null);
    try {
      if (simMode) {
        await delay(800);
        // Harmless placeholder — the real flow opens Claude's actual OAuth URL
        // (printed by `claude auth login`, complete with client_id). Never
        // point sim at a real claude.com URL: it 400s ("missing client_id").
        setLoginUrl(
          'data:text/html,<body style="font-family:sans-serif;background:%230a0a0a;color:%23f5e8c8;padding:3rem"><h2>Simulated sign-in</h2><p>In the real setup, this opens Claude%27s actual sign-in page.</p></body>',
        );
        await delay(1400);
        simPreflight.current.auth = { status: 'authed', note: 'Simulated sign-in.' };
        setPreflight({ ...simPreflight.current });
        setBusy(null);
        return;
      }
      await settingsApi.startOnboardingLogin();
      // Poll until CC reports signed-in (or the login process fails).
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        void settingsApi.getOnboardingAuthState()
          .then((s) => {
            if (s.login.url) setLoginUrl(s.login.url);
            if (s.authed) {
              if (pollRef.current) clearInterval(pollRef.current);
              setPreflight((prev) =>
                prev ? { ...prev, auth: { status: 'authed', note: 'Signed in.' } } : prev,
              );
              setBusy(null);
            } else if (s.login.exited && s.login.exitCode !== 0) {
              if (pollRef.current) clearInterval(pollRef.current);
              setError('Sign-in didn’t complete. Try again, or use Re-check if you finished in the browser.');
              setBusy(null);
            }
          })
          .catch(() => {
            /* transient — keep polling */
          });
      }, 2500);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function handleRefresh() {
    setBusy('refresh');
    setError(null);
    try {
      await refreshPreflight();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function goNext() {
    const idx = STEP_ORDER.indexOf(step);
    const next = STEP_ORDER[idx + 1];
    if (next) setStep(next);
  }

  function handleSelectProjectsFolder(path: string) {
    setProjectsFolder(path);
    setFolderPickerOpen(false);
    onProjectsFolderChange(path);
  }

  function handleDefaultSurface(surface: OrchestratorSurfacePreference) {
    setDefaultSurface(surface);
    onDefaultSurfaceChange(surface);
  }

  const hardDepsMissing = !claudeOk || !gitOk;

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6 text-foreground">
      <div className="flex h-[86vh] max-h-[760px] w-full max-w-5xl overflow-hidden border border-border bg-card shadow-2xl">
        {/* Stepper rail */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/20 p-5">
          <div className="mb-6 flex items-center gap-2">
            <span className="text-base font-bold uppercase tracking-[0.16em] text-primary">
              caisson
            </span>
            <span className="text-[10px] uppercase tracking-wide text-[var(--fg-dim)]">setup</span>
          </div>
          <ol className="space-y-1">
            {STEP_ORDER.map((s) => (
              <StepRow
                key={s}
                title={STEP_TITLES[s]}
                active={s === step}
                done={satisfied(s)}
              />
            ))}
          </ol>
          <div className="mt-auto pt-4">
            <button
              type="button"
              onClick={() => onSkip(hardDepsMissing)}
              className="text-[11px] text-[var(--fg-dim)] underline-offset-2 hover:text-foreground hover:underline"
            >
              Skip for now
            </button>
            {simMode && (
              <p className="mt-2 text-[10px] uppercase tracking-wide text-warning">
                sim mode — fake machine
              </p>
            )}
          </div>
        </aside>

        {/* Content */}
        <section className="flex flex-1 flex-col overflow-y-auto p-8">
          {!preflight ? (
            <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
              Checking your machine…
            </div>
          ) : (
            <>
              {step === 'welcome' && <WelcomeStep onNext={goNext} />}

              {step === 'experience' && (
                <ExperienceStep
                  selected={defaultSurface}
                  onSelect={handleDefaultSurface}
                  onNext={goNext}
                />
              )}

              {step === 'claude' && (() => {
                // Caisson ships a pinned, isolated Claude Code inside the app
                // (resolver `source: 'bundled'`), so on a packaged build there is
                // nothing for the user to install — reframe the step from
                // "install it" to "it's already here". The install action stays
                // for the dev/fallback case where no bundle resolves.
                const bundled = preflight.claude.source === 'bundled';
                const v = preflight.claude.version ?? '';
                return (
                  <DependencyStep
                    title="Claude Code"
                    blurb={
                      bundled
                        ? "Caisson ships with its own pinned copy of Claude Code, so there's nothing to install. It runs every chat, agent, and workflow for you."
                        : "Caisson runs every chat, agent, and workflow by driving Claude Code on your machine. Let's make sure it's installed."
                    }
                    ok={claudeOk}
                    okLabel={
                      claudeOk
                        ? bundled
                          ? `Claude Code ${v} — bundled with Caisson. Nothing to install.`
                          : `Claude Code ${v} found on your machine.`
                        : undefined
                    }
                    problem={
                      preflight.claude.status === 'version-too-old'
                        ? `Found ${preflight.claude.version}, but Caisson needs ${preflight.claude.minVersion} or newer.`
                        : preflight.claude.status === 'unverified'
                          ? 'A claude binary was found but its version could not be read.'
                          : 'Claude Code is not installed yet.'
                    }
                    actionLabel="Install Claude Code"
                    busy={busy === 'claude'}
                    busyLabel="Installing Claude Code…"
                    onAction={handleInstallClaude}
                    onNext={goNext}
                  />
                );
              })()}

              {step === 'git' && (
                <DependencyStep
                  title="Install Git"
                  blurb="Caisson uses git to create projects and isolate agent work. It only takes a moment to install."
                  ok={gitOk}
                  okLabel={gitOk ? `git ${preflight.git.version ?? ''} found.` : undefined}
                  problem="Git is not installed yet."
                  actionLabel="Install Git"
                  busy={busy === 'git'}
                  busyLabel="Installing Git…"
                  onAction={handleInstallGit}
                  onNext={goNext}
                />
              )}

              {step === 'auth' && (
                <AuthStep
                  authed={authOk}
                  busy={busy === 'auth'}
                  refreshing={busy === 'refresh'}
                  loginUrl={loginUrl}
                  onSignIn={handleSignIn}
                  onRefresh={handleRefresh}
                  onNext={goNext}
                />
              )}

              {step === 'projects' && (
                <ProjectsFolderStep
                  folder={projectsFolder}
                  onChoose={() => setFolderPickerOpen(true)}
                  onNext={goNext}
                />
              )}

              {step === 'done' && (
                <DoneStep
                  softDeps={preflight.soft}
                  hardDepsMissing={hardDepsMissing}
                  defaultSurface={defaultSurface}
                  onComplete={onComplete}
                />
              )}

              {/* shared footer: log + error */}
              {(log || error) && (
                <div className="mt-4">
                  {error && (
                    <p className="bg-destructive/15 px-3 py-2 text-xs text-destructive">{error}</p>
                  )}
                  {log && !error && (
                    <p className="bg-muted/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      {log}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {folderPickerOpen && (
        <FolderBrowserModal
          initialPath={projectsFolder || undefined}
          onCancel={() => setFolderPickerOpen(false)}
          onSelect={handleSelectProjectsFolder}
        />
      )}
    </div>
  );
}

function StepRow({ title, active, done }: { title: string; active: boolean; done: boolean }) {
  const glyph = done ? '✓' : active ? '●' : '○';
  const glyphColor = done ? 'text-success' : active ? 'text-primary' : 'text-[var(--fg-dim)]';
  return (
    <li
      className={`flex items-center gap-2 px-2 py-1.5 text-sm ${
        active ? 'bg-muted/50 text-foreground' : 'text-muted-foreground'
      }`}
    >
      <span className={`w-4 text-center ${glyphColor}`}>{glyph}</span>
      <span>{title}</span>
    </li>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-1 flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Welcome to Caisson</h1>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
        Caisson is your local control surface for Claude Code — a place to run a
        persistent project assistant, dispatch agents, and automate work, all on
        your own machine.
      </p>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
        This quick setup makes sure everything Caisson needs is in place. It
        takes a couple of minutes.
      </p>
      <div className="mt-auto pt-6">
        <PrimaryButton onClick={onNext}>Get started</PrimaryButton>
      </div>
    </div>
  );
}

function ExperienceStep({
  selected,
  onSelect,
  onNext,
}: {
  selected: OrchestratorSurfacePreference;
  onSelect: (surface: OrchestratorSurfacePreference) => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Choose your default view</h1>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
        Start new project sessions in the surface that matches how you prefer to
        drive Claude Code.
      </p>

      <div className="mt-6 grid min-h-0 flex-1 grid-cols-[260px_1fr] gap-5">
        <div className="flex flex-col gap-2">
          <SurfaceChoice
            surface="chat"
            selected={selected === 'chat'}
            title="Chat"
            blurb="Structured conversation, clearer history, work-item links."
            onSelect={onSelect}
          />
          <SurfaceChoice
            surface="terminal"
            selected={selected === 'terminal'}
            title="Terminal"
            blurb="Native Claude Code screen, slash commands, raw CLI behavior."
            onSelect={onSelect}
          />
        </div>
        <SurfacePreview surface={selected} />
      </div>

      <div className="mt-auto pt-6">
        <PrimaryButton onClick={onNext}>Continue</PrimaryButton>
      </div>
    </div>
  );
}

function SurfaceChoice({
  surface,
  selected,
  title,
  blurb,
  onSelect,
}: {
  surface: OrchestratorSurfacePreference;
  selected: boolean;
  title: string;
  blurb: string;
  onSelect: (surface: OrchestratorSurfacePreference) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(surface)}
      className={
        'border px-3 py-3 text-left transition-colors ' +
        (selected
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground')
      }
    >
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-xs leading-relaxed">{blurb}</div>
    </button>
  );
}

function SurfacePreview({ surface }: { surface: OrchestratorSurfacePreference }) {
  if (surface === 'terminal') {
    return (
      <div className="flex min-h-0 flex-col border border-border bg-background p-3">
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>Terminal</span>
          <span>120x30</span>
        </div>
        <div className="flex-1 overflow-hidden bg-[#050505] p-3 font-mono text-xs leading-5 text-[#d6f5d6]">
          <div>$ claude</div>
          <div className="text-[#9bd4ff]">/help</div>
          <div>Commands</div>
          <div>  /model  choose a model</div>
          <div>  /memory edit memory files</div>
          <div className="mt-2">Thinking...</div>
          <div className="inline-block h-4 w-2 animate-pulse bg-[#d6f5d6]" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col border border-border bg-background p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">Chat</div>
      <div className="flex flex-1 flex-col gap-3 overflow-hidden">
        <div className="ml-auto max-w-[70%] border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
          Plan the first milestone.
        </div>
        <div className="max-w-[78%] border border-border bg-card px-3 py-2 text-xs">
          I will map the repo, create work items, and propose the first slice.
        </div>
        <div className="max-w-[62%] border border-border bg-muted/30 px-3 py-2 text-xs">
          Read project notes
        </div>
        <div className="max-w-[72%] border border-success/50 bg-success/10 px-3 py-2 text-xs">
          Linked TASK-12 and TASK-13.
        </div>
      </div>
    </div>
  );
}

interface DependencyStepProps {
  title: string;
  blurb: string;
  ok: boolean;
  okLabel?: string;
  problem: string;
  actionLabel: string;
  busy: boolean;
  busyLabel: string;
  onAction: () => void;
  onNext: () => void;
}

function DependencyStep({
  title,
  blurb,
  ok,
  okLabel,
  problem,
  actionLabel,
  busy,
  busyLabel,
  onAction,
  onNext,
}: DependencyStepProps) {
  return (
    <div className="flex flex-1 flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">{blurb}</p>

      <div className="mt-6">
        {ok ? (
          <div className="flex items-center gap-2 bg-success/15 px-3 py-2 text-sm text-success">
            <span>✓</span>
            <span>{okLabel}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 bg-warning/15 px-3 py-2 text-sm text-warning">
            <span>!</span>
            <span>{problem}</span>
          </div>
        )}
      </div>

      <div className="mt-auto flex items-center gap-3 pt-6">
        {ok ? (
          <PrimaryButton onClick={onNext}>Continue</PrimaryButton>
        ) : (
          <PrimaryButton onClick={onAction} disabled={busy}>
            {busy ? busyLabel : actionLabel}
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}

interface AuthStepProps {
  authed: boolean;
  busy: boolean;
  refreshing: boolean;
  loginUrl: string | null;
  onSignIn: () => void;
  onRefresh: () => void;
  onNext: () => void;
}

function AuthStep({
  authed,
  busy,
  refreshing,
  loginUrl,
  onSignIn,
  onRefresh,
  onNext,
}: AuthStepProps) {
  return (
    <div className="flex flex-1 flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to Claude</h1>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
        Caisson uses your Claude subscription to do its work. This is the same
        sign-in you'd use for Claude Code in a terminal — sign in here and you're
        signed in everywhere.
      </p>

      <div className="mt-6 space-y-3">
        {authed ? (
          <div className="flex items-center gap-2 bg-success/15 px-3 py-2 text-sm text-success">
            <span>✓</span>
            <span>You're signed in.</span>
          </div>
        ) : busy ? (
          <div className="bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Your browser is opening to sign in to Claude. Finish there and this
            will update automatically.
          </div>
        ) : (
          <div className="flex items-center gap-2 bg-warning/15 px-3 py-2 text-sm text-warning">
            <span>!</span>
            <span>You're not signed in yet.</span>
          </div>
        )}

        {!authed && busy && loginUrl && (
          <a
            href={loginUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block !bg-primary px-4 py-2 text-sm font-medium !text-primary-foreground hover:!bg-primary/90"
          >
            Open the sign-in page
          </a>
        )}
      </div>

      <div className="mt-auto flex items-center gap-3 pt-6">
        {authed ? (
          <PrimaryButton onClick={onNext}>Continue</PrimaryButton>
        ) : (
          <>
            <PrimaryButton onClick={onSignIn} disabled={busy}>
              {busy ? 'Waiting for sign-in…' : 'Sign in to Claude'}
            </PrimaryButton>
            <SecondaryButton onClick={onRefresh} disabled={refreshing}>
              {refreshing ? 'Checking…' : 'Re-check'}
            </SecondaryButton>
          </>
        )}
      </div>
    </div>
  );
}

function ProjectsFolderStep({
  folder,
  onChoose,
  onNext,
}: {
  folder: string;
  onChoose: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Where should your projects live?</h1>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
        Caisson keeps each project in its own folder under one parent directory.
        Pick where that should be — you can change it later in settings, and make
        a new folder right from the picker.
      </p>

      <div className="mt-6 max-w-xl">
        <span className="text-xs uppercase tracking-wide text-[var(--fg-dim)]">Projects folder</span>
        <div className="mt-1 flex items-center gap-3">
          <code className="flex-1 truncate border border-border bg-muted/40 px-3 py-2 font-mono text-sm">
            {folder || 'Not set'}
          </code>
          <SecondaryButton onClick={onChoose}>Choose folder…</SecondaryButton>
        </div>
      </div>

      <div className="mt-auto pt-6">
        <PrimaryButton onClick={onNext} disabled={!folder.trim()}>
          Continue
        </PrimaryButton>
      </div>
    </div>
  );
}

function DoneStep({
  softDeps,
  hardDepsMissing,
  defaultSurface,
  onComplete,
}: {
  softDeps: PreflightReport['soft'];
  hardDepsMissing: boolean;
  defaultSurface: OrchestratorSurfacePreference;
  onComplete: () => void;
}) {
  const missingSoft = softDeps.filter((d) => !d.present).map((d) => d.name);
  return (
    <div className="flex flex-1 flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">You're all set</h1>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
        Everything Caisson needs is ready. Create your first project to get
        going — Caisson's assistant will help you set it up.
      </p>

      {missingSoft.length > 0 && (
        <div className="mt-6 max-w-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="text-foreground">Optional:</span> {missingSoft.join(', ')}{' '}
          {missingSoft.length === 1 ? 'is' : 'are'} not installed. You only need
          {' '}{missingSoft.length === 1 ? 'it' : 'them'} for workflow steps that
          run code — you can add {missingSoft.length === 1 ? 'it' : 'them'} later.
        </div>
      )}

      <div className="mt-4 max-w-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Default view:{' '}
        <span className="font-medium capitalize text-foreground">{defaultSurface}</span>
      </div>

      <div className="mt-auto pt-6">
        <PrimaryButton onClick={onComplete} disabled={hardDepsMissing}>
          Create your first project
        </PrimaryButton>
        {hardDepsMissing && (
          <p className="mt-2 text-xs text-warning">
            Finish the steps above first — Caisson can't run without Claude Code and git.
          </p>
        )}
      </div>
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="!bg-primary px-4 py-2 text-sm font-medium !text-primary-foreground hover:!bg-primary/90 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="border border-border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
    >
      {children}
    </button>
  );
}
