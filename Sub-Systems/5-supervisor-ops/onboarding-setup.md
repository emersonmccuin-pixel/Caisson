# Onboarding & Setup

> **Role:** cross-cutting (UI + server services; no runtime ownership)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> - `apps/server/src/services/preflight.ts`
> - `apps/server/src/services/onboarding-auth.ts`
> - `apps/server/src/services/onboarding-install.ts`
> - `apps/server/src/services/project-create.ts`
> - `apps/server/src/services/project-scaffold.ts`
> - `apps/server/src/services/project-registry.ts`
> - `apps/server/src/services/claude-runtime-bundle.ts`
> - `apps/server/src/features/settings-onboarding/routes.ts`
> - `apps/web/src/components/onboarding/OnboardingWizard.tsx`
> - `apps/web/src/components/SetupWizardModal.tsx`
> - `apps/web/src/components/CreateProjectModal.tsx`
> - `templates/` (hook scripts, settings, MCP config, prompts)

---

## What it is (plain English)

Two separate flows that happen once each per install or per project.

**First-run wizard** (`OnboardingWizard`): a full-screen gate shown before the main app on first launch. It walks a non-technical user from a bare machine through installing Claude Code, installing git, signing in to Claude (via Claude's own OAuth), picking a projects folder, and landing at "Create your first project."

**Project-creation + setup wizard** (`CreateProjectModal` → `SetupWizardModal`): creates a folder on disk, runs `git init`, writes the Caisson scaffold files, inserts a DB row, and then optionally opens an AI-driven interview that produces the project's `CLAUDE.md`.

---

## What it's supposed to do (intent)

Get a fresh install from zero to a working project with zero terminal use — click-through only. Also gate re-entry: if the user skips or the machine already has everything, neither wizard shows again.

---

## How it works today (as-built)

### Gate logic (App.tsx:343–351)

The first-run wizard shows when ALL of:
- `settings.onboardingCompletedAt === null` (never finished or skipped)
- `projects.length === 0` (no projects yet)
- `?onboarding=force` or `?onboarding=sim` overrides the condition for dev testing

`?onboarding=sim` replaces every real action with a fake delayed version — the full wizard is walkable on a machine that already has everything. `?onboarding=force` uses real preflight + real installs.

### Preflight (`preflight.ts`)

`runPreflight()` probes the machine and returns a typed `PreflightReport`:
- **claude:** resolves the binary via `@pc/runtime`'s `resolveClaudeBinary`, runs `--version`, compares against `MIN_CLAUDE_VERSION = '2.0.0'`. Status: `ok | not-found | version-too-old | unverified`.
- **auth:** calls `claude auth status --json` (a LOCAL token read — no network, no billing). Parses `{ loggedIn }`. Status: `authed | login-required | unknown`.
- **git:** probes `git --version`. Hard dependency.
- **soft:** node, bash, python. Soft — only needed for workflow code-nodes.
- `ok = claude.status === 'ok' && git.present`.

Exposed at `GET /api/preflight`.

### Install actions (`onboarding-install.ts`)

Triggered only by explicit user click; never auto-runs.

- **Claude Code (Windows):** `powershell -Command 'irm https://claude.ai/install.ps1 | iex'`. macOS: `curl … | bash`. Clears the binary probe cache after, re-runs preflight.
- **git (Windows):** `winget install Git.Git --silent` first; falls back to fetching the latest 64-bit installer from GitHub releases and running `/VERYSILENT`. macOS: Homebrew first, then `xcode-select --install`.
- Both return `InstallResult { preflight, log }` so the wizard can update state in one round-trip.

### Auth flow (`onboarding-auth.ts`)

- `startLogin()` spawns `claude auth login --claudeai` as a detached child process. Scrapes its stdout/stderr for a `visit: <url>` line as a fallback button.
- The wizard polls `GET /api/onboarding/auth/state` every 2.5 s. The endpoint calls `probeAuth()` (re-runs `claude auth status --json`) and merges in the live process state.
- On sign-in success (CC writes its own `~/.claude/.credentials.json`) the poll sees `authed: true` and stops. On process exit with non-zero code, the poll surfaces an error.
- `cancelLogin()` kills the child (called on wizard unmount).

### API routes (`settings-onboarding/routes.ts`)

All registered under the same Hono app as global settings:

| Endpoint | Purpose |
|---|---|
| `GET /api/preflight` | Run preflight, return report |
| `POST /api/onboarding/install/claude` | Run Claude Code installer |
| `POST /api/onboarding/install/git` | Run git installer |
| `POST /api/onboarding/auth/login` | Start `claude auth login` |
| `GET /api/onboarding/auth/state` | Poll login + auth state |
| `POST /api/onboarding/auth/cancel` | Kill in-flight login |
| `GET /api/settings` | Read global settings |
| `PATCH /api/settings` | Write global settings (incl. `onboardingCompletedAt`) |

Completion is stamped by `PATCH /api/settings { onboardingCompletedAt: <ISO> }` at `onComplete` and `onSkip`.

### Project creation (`project-create.ts`)

Three modes — chosen by probing the folder at `POST /api/fs/probe` before the form is submitted:

| Mode | Trigger | What happens |
|---|---|---|
| `init-empty` | Folder exists, empty | `git init -b main`, scaffold, commit `Initial commit` |
| `init-in-place` | Folder has files, no `.git` | `git init`, commit existing as `Initial import`, scaffold, commit `Add Caisson scaffold` |
| `attach-to-git` | Already a git repo | Skip `git init`; scaffold (no README); stage only `.project-companion/`; commit `Add Caisson scaffold` |

Steps (project-create.ts:79–175):
1. Validate name + mode + folder.
2. `mkdirSync(folderPath, { recursive: true })`.
3. Mint a ULID (`id = newId()`).
4. Derive a unique slug — kebab-case the name; append `-2`, `-3`, … until not in DB.
5. For attach-to-git: if `.project-companion/` exists and `replaceExisting` is set, `rmSync` it first.
6. `git init -b main` (non-attach modes).
7. `git add . && git commit -m 'Initial import'` (init-in-place with pre-existing files).
8. Write scaffold files (see below).
9. `git add` + `git commit`.
10. `persistCreatedProjectWithLiveEvent(...)` — inserts DB row + emits live event.
11. `registry.register(result.project)` — adds a `ProjectRuntime` to the in-memory registry.

Default stages: `Draft (isNew) → Review → Done (isDone) → Cancelled (isCancelled)` (project-create.ts:61–65).

### Scaffold writer (`project-scaffold.ts`)

Writes to `<folder>/`:

| Path | Source | Template? |
|---|---|---|
| `.project-companion/setup-wizard-prompt.md` | `templates/.project-companion/setup-wizard-prompt.md` | Yes — `{{PROJECT_NAME}}`, `{{PROJECT_SLUG}}` |
| `.project-companion/workflows/*.yaml` | `templates/.project-companion/workflows/` | No — plain copy |
| `README.md` | `templates/README.template.md` | Yes — `{{PROJECT_NAME}}`, `{{PC_TRUNK_PATH}}` |

Attach-to-git mode skips `README.md` to preserve the existing repo's readme.

Token map (project-scaffold.ts:110–122): `PC_TRUNK_PATH`, `PC_SERVER_PORT`, `PC_CHANNEL_PORT`, `PC_DB_PATH`, `PROJECT_ID`, `PROJECT_SLUG`, `PROJECT_FOLDER`, `PROJECT_NAME`, `PROJECT_DATA_DIR`.

**What is NOT scaffolded into the project folder:** `.claude/hooks/`, `.claude/settings.json`, `.mcp.json`. These used to land in project roots (see legacy-runtime-cleanup.ts) but were moved to per-session scratch dirs. They now come from `claude-runtime-bundle.ts` at spawn time.

### Runtime bundle (not scaffold — per session) (`claude-runtime-bundle.ts`)

At every `claude.exe` spawn, `prepareClaudeRuntimeFiles(input)` renders the template files into a per-session scratch dir (`<scratchDir>/claude-runtime/`):
- `.claude/hooks/*.cjs` — all `.cjs` files from `templates/.claude/hooks/` with token substitution. **Hook token `PROJECT_FOLDER` points at the worktree dir**; settings token `PROJECT_FOLDER` points at the session scratch `claude-runtime/` dir (so hooks reference themselves correctly).
- `.claude/settings.json` — rendered from `templates/.claude/settings.template.json`.
- `mcp.json` — `pc-rig` + `webhook` MCP servers, with token-substituted paths + env.
- Cleaned up on session end via `cleanup()`.

Hook scripts registered in `settings.json`:
- `inbox-drain.cjs` — UserPromptSubmit; drains `agent_inbox` table rows into the conversation.
- `event-capture.cjs` — all CC lifecycle events (UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop, SessionEnd, StopFailure, Notification).
- `ask-intercept.cjs` — PreToolUse on `AskUserQuestion|ExitPlanMode|EnterPlanMode`.
- `path-guard.cjs` — PreToolUse/PostToolUse on Agent/Task + file tools (gate-workflow, bind/unbind, enforce).
- `pc-statusline.cjs` — statusLine command.

### Project registry (`project-registry.ts`)

In-memory map of `ULID → ProjectRuntime`. Loaded from DB at server boot (`loadAll()`). `register()` is called by `ProjectCreate.create()` immediately after the DB insert, so the new project is live without a restart. `ensure()` lazily hydrates a runtime on first access.

### Setup wizard modal (`SetupWizardModal.tsx` + `setup-wizard-prompt.md`)

After project creation, the user can open the setup wizard — a transient Claude session that interviews them and calls `pc_write_claude_md` to write `CLAUDE.md` to the project root. The interview script is `templates/.project-companion/setup-wizard-prompt.md` (appended to CC's system prompt at spawn via `--append-system-prompt-file` or equivalent). The modal auto-closes when the `project-claude-md` live-store signature changes (T3.2b: `useLiveEntitySignature`).

---

## Integrations (how it connects)

- **Depends on:**
  - `@pc/runtime` — `resolveClaudeBinary`, `requireClaudeBinary`, `claudeConfigDir`, `setConfiguredClaudeExe`.
  - `@pc/db` — `getGlobalSettings`, `setGlobalSettings`, `getProjectBySlug`, `getProjectById`, `listProjects`, `persistCreatedProjectWithLiveEvent`.
  - `@pc/domain` — `Stage`, `GlobalSettings`, `withSettingsDefaults`.
  - `project-scaffold.ts` — called by `project-create.ts`.
  - `claude-runtime-bundle.ts` — called by the spawn path (not by project-create directly).
  - `project-runtime.ts` + `ProjectRegistry` — runtime registered on project create.

- **Used by:**
  - `App.tsx` — mounts `OnboardingWizard` as a full-screen gate.
  - `POST /api/projects` — thin wrapper around `ProjectCreate.create`.
  - Every `claude.exe` spawn path (`LowLevelSpawn`, `InteractiveSession`, `AgentRun`) calls `prepareClaudeRuntimeFiles`.

- **Contracts / events crossed:**
  - `GlobalSettings.onboardingCompletedAt` (DB, `global_settings` table) — the gate flag.
  - `Project` row + `persistCreatedProjectWithLiveEvent` — DB insert + live WS event.
  - `setup-wizard-state` / `setup-wizard-exit` WS envelopes — consumed by `SetupWizardModal`.
  - `project-claude-md` live-store signature — triggers modal auto-close.

---

## Target shape (per north star)

The ledger (`consolidation-ledger-2026-06-02.md`) has no explicit row for this subsystem because it has no lifecycle ownership or process concerns — it is not in the five-role migration path.

The one structural note: the setup wizard modal (`SetupWizardModal`) is a transient `PtySession`-owned modal (V1 confirmed: `project-runtime.ts:117`). Per Steps 5–6 of the migration, all transient modals eventually move to the Engine. When that happens, `SetupWizardModal`'s WS envelope handling (`setup-wizard-state`, `setup-wizard-exit`) migrates with it — but the wizard's interview content, scaffold logic, and preflight are unaffected.

Everything else (preflight, install, auth, project-create, scaffold, registry) is self-contained and maps cleanly to the target: the DB is the source of truth for projects; the scaffold produces durable files; the session bundle produces ephemeral runtime config per spawn. No changes needed beyond the modal migration.

---

## Known issues / scar tissue

- **Hook template trap** (CLAUDE.md memory note). The hook `.cjs` files live in `templates/.claude/hooks/` — that is the only real location (verified: `packages/runtime/src/hook-scripts/` does not exist). A prior session burned time editing the wrong path. **Always edit `templates/.claude/hooks/`.**

- **`inbox-drain.cjs` reads `agent_inbox` tables directly** (ledger §0, item 1). The `agent_inbox` DB tables are targeted for deletion, but the hook still reads/writes them via raw SQL (lines 66/74/77 of the hook). The tables cannot be dropped until this hook is refactored to use the mailbox. This is a known pending item (ledger row 9, prereq: mailbox-stable + hook refactor).

- **`.mcp.json` and `.claude/*` no longer live in the project folder.** The `README.template.md` scaffold still lists them as if they do (templates/README.template.md:8–11). The README is stale on this point; the actual files land in the session scratch dir, not the project root. This is cosmetic but misleading for users who look at the committed README.

- **Legacy runtime cleanup** (`legacy-runtime-cleanup.ts`). Projects created before the session-bundle move still have `.mcp.json`, `.claude/settings.json`, and `.claude/hooks/*.cjs` in their project roots. There is a cleanup service that detects and backs them up/removes them on boot. This is defense-in-depth against old installs, not a live concern for new projects.

- **Partial-scaffold failure is unrecovered.** If a `git commit` fails mid-create, the folder is left with partial files. The comment in `project-create.ts:30` notes that atomic rollback is a followup. No rollback path exists today.

- **`attach-to-git` re-adopt path** deletes `.project-companion/` before scaffolding a fresh copy, but this is a working-tree-only delete; the git history retains the old scaffold. If the user commits in the same repo after re-adoption they'll see the old scaffold in log history. Cosmetic, not a bug.

---

## Open questions

- Should `README.template.md` be updated to match the current reality (no `.claude/` or `.mcp.json` in the project root)?
- When the setup wizard modal migrates to the Engine (Step 5), does `SetupWizardModal`'s auto-close via `useLiveEntitySignature` still work, or does the event path change?
- The onboarding wizard has no re-entry mechanism once `onboardingCompletedAt` is set. There is no "re-run setup" button in app settings. Intentional?
