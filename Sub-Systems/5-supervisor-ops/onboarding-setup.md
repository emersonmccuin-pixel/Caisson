# Onboarding & Setup

> **Role:** cross-cutting (UI + server services; no runtime ownership)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `apps/server/src/services/preflight.ts` · `onboarding-auth.ts` · `onboarding-install.ts` · `project-create.ts` · `project-scaffold.ts` · `project-registry.ts` · `claude-runtime-bundle.ts`
> `apps/server/src/features/settings-onboarding/routes.ts`
> `apps/web/src/components/onboarding/OnboardingWizard.tsx` · `SetupWizardModal.tsx` · `CreateProjectModal.tsx`
> `templates/` (hook scripts, settings template, MCP config, prompts)

---

## What it is (plain English)

Two one-time flows — one per install, one per project — that get a new user from a bare machine to a working project without opening a terminal. The **first-run wizard** is a full-screen walkthrough that installs the software, signs you in, and hands you off to create your first project. The **project setup wizard** turns a folder into a git-tracked Caisson project with the right files, and then (optionally) interviews you to write that project's instruction file.

---

## What it's supposed to do (intent)

Zero-to-working-project by click-through only. Gate re-entry: once the machine is set up and a project exists, neither wizard appears again. Every install action is user-initiated — nothing runs silently in the background.

---

## The parts (every component, plain English)

### 1. The show/hide gate

The first-run wizard appears when **all three** of these are true (`App.tsx:343–351`):
- Onboarding has never been completed or skipped (`settings.onboardingCompletedAt === null`).
- No projects exist yet (`projects.length === 0`).
- No URL override is set.

Two dev-only URL overrides exist for testing:
- `?onboarding=sim` — runs the whole wizard with fake delays; every action is pretend. Safe to walk through on a machine that's already set up.
- `?onboarding=force` — runs real preflight and real installers.

Once the user finishes or skips, a timestamp is written (`PATCH /api/settings { onboardingCompletedAt: <ISO> }`). That timestamp is the permanent gate flag.

There is no "re-run setup" button in the app once the flag is set — getting back to the wizard requires manually clearing `onboardingCompletedAt` in settings. See open questions.

---

### 2. Preflight checks

Before asking you to install anything, the app checks what's already on the machine. These checks run at `GET /api/preflight` and return a typed report (`preflight.ts`):

| Check | What it looks for | Possible results |
|---|---|---|
| **Claude Code** | Finds the binary, runs `--version`, checks it's ≥ 2.0.0 — ⚠️ **FD-22 changes this to an exact-pin check** (today's floor-check is the gap Emerson flagged) | `ok` · `not-found` · `version-too-old` · `unverified` |
| **Auth (sign-in)** | Runs `claude auth status --json` — reads a local token file, no network call | `authed` · `login-required` · `unknown` |
| **git** | Probes `git --version` | `present` / not present |
| **Node / Bash / Python** | Soft checks — only needed for workflow code steps | present / not present |

The gate clears (`ok = true`) when Claude Code status is `ok` **and** git is present. The soft deps don't block.

---

### 3. Install actions

Triggered only by an explicit button click — never automatic (`onboarding-install.ts`).

**Claude Code:**
- Windows: runs `powershell -Command 'irm https://claude.ai/install.ps1 | iex'`.
- macOS: runs the equivalent `curl … | bash`.
- After install: clears the binary-probe cache, re-runs preflight.

**git:**
- Windows: tries `winget install Git.Git --silent` first; if that fails, fetches the latest 64-bit installer from GitHub and runs it silently (`/VERYSILENT`).
- macOS: tries Homebrew first, then `xcode-select --install`.

Both return the updated preflight report in the same response, so the wizard reflects current state immediately.

---

### 4. Sign-in flow

Claude Code manages its own sign-in process; Caisson just drives it (`onboarding-auth.ts`).

1. **Start:** `POST /api/onboarding/auth/login` spawns `claude auth login --claudeai` as a background child process. If it prints a `visit: <url>` line to stdout, that URL is surfaced as a fallback button.
2. **Poll:** The wizard calls `GET /api/onboarding/auth/state` every 2.5 seconds. Each call re-checks `claude auth status --json` and merges in the live process state.
3. **Success:** Claude Code writes its own `~/.claude/.credentials.json` when you sign in. The next poll sees `authed: true` and stops.
4. **Failure:** If the child process exits with a non-zero code, the poll surfaces an error.
5. **Cancel:** `POST /api/onboarding/auth/cancel` kills the child process. Also called on wizard unmount.

---

### 5. The setup wizard (interview)

After a project is created, the user can open the setup wizard — a transient Claude session that interviews them about their project and calls `pc_write_claude_md` to write `CLAUDE.md` into the project root (`SetupWizardModal.tsx`).

The interview script is in `templates/.project-companion/setup-wizard-prompt.md` — it's appended to Claude's system prompt at spawn time. The modal watches the `project-claude-md` live-store signature and auto-closes when the file is written.

The setup wizard is a transient `PtySession`-owned modal (confirmed: `project-runtime.ts:117`).

> ☠ **FD-21 (locked 2026-06-03): the project setup wizard dies** with the other transient modals —
> "too complicated and not necessary" (Emerson). The orchestrator does this job in the one chat:
> "tell me about this project" → writes `CLAUDE.md`. The **first-run wizard stays** (a bare machine
> needs install + sign-in + first project).

---

### 6. Creating a project

`POST /api/projects` accepts a folder path and project name, probes the folder first (`POST /api/fs/probe`), and picks one of three modes (`project-create.ts:79–175`):

| Mode | When it applies | What happens |
|---|---|---|
| `init-empty` | Folder exists but is empty | `git init -b main`, scaffold, commit `Initial commit` |
| `init-in-place` | Folder has files but no `.git` | `git init`, commit existing as `Initial import`, scaffold, commit `Add Caisson scaffold` |
| `attach-to-git` | Folder is already a git repo | Skip `git init`; write + commit **nothing** — adoption is purely a DB-side registration |

Steps in order:
1. Validate name + mode + folder.
2. Create the folder if it doesn't exist.
3. Mint a ULID for the project ID.
4. Derive a slug — kebab-case the name; append `-2`, `-3`, … to avoid DB collisions.
5. `git init -b main` (non-attach modes).
6. Commit pre-existing files (init-in-place only).
7. Write scaffold + `git add` + `git commit` (non-attach modes only).
8. Insert the DB row + emit a live event.
9. Register the project in the in-memory registry so it's live immediately without a restart.

Default stages created: `Draft (isNew) → Review → Done (isDone) → Cancelled (isCancelled)` (`project-create.ts:61–65`).

⚠️ **Known gap:** if a `git commit` fails mid-create, the folder is left with partial files. No rollback path exists. (`project-create.ts:30`)

---

### 7. What gets scaffolded into the project folder

`project-scaffold.ts` writes exactly one file — no more (`project-scaffold.ts`):

| Path | Source | Template tokens? |
|---|---|---|
| `README.md` | `templates/README.template.md` | `{{PROJECT_NAME}}`, `{{PC_TRUNK_PATH}}` |

`attach-to-git` mode skips the scaffold entirely — nothing is written into the user's repo. `.project-companion/` left the scaffold whole: workflow YAML seeds died with the DB promotion (19.13 importer remains as the legacy migration door at project boot), `setup-wizard-prompt.md` left with FD-21.

Token map (`project-scaffold.ts:110–122`): `PC_TRUNK_PATH`, `PC_SERVER_PORT`, `PC_CHANNEL_PORT` *(☠ FD-3 — goes away with the port-consolidation Foundation Decision)*, `PC_DB_PATH`, `PROJECT_ID`, `PROJECT_SLUG`, `PROJECT_FOLDER`, `PROJECT_NAME`, `PROJECT_DATA_DIR`.

**What does NOT land in the project folder** (and why this matters):
- `.claude/hooks/` — not here.
- `.claude/settings.json` — not here.
- `.mcp.json` — not here.

These used to be written into project roots. They were moved to **per-session scratch dirs** (see §8). Old projects created before that move still have them; a cleanup service (`legacy-runtime-cleanup.ts`) backs them up and removes them on boot.

⚠️ **Known stale doc:** `README.template.md:8–11` still lists `.claude/` and `.mcp.json` as if they live in the project root. They don't. The README is misleading for anyone who reads it.

---

### 8. Runtime bundle (per session, not scaffold)

Every time Claude is launched — for any session type — `prepareClaudeRuntimeFiles(input)` renders a fresh set of config files into a **per-session scratch dir** (`<scratchDir>/claude-runtime/`) (`claude-runtime-bundle.ts`). These are ephemeral: created at spawn, deleted at session end.

Files written each time:
- `.claude/hooks/*.cjs` — every `.cjs` from `templates/.claude/hooks/` with token substitution. Hook token `PROJECT_FOLDER` points at the worktree dir; settings token `PROJECT_FOLDER` points at the scratch dir so hooks reference themselves correctly.
- `.claude/settings.json` — rendered from `templates/.claude/settings.template.json`.
- `mcp.json` — `pc-rig` + `webhook` MCP servers with token-substituted paths and env.

**Hook scripts registered in `settings.json`:**

| Script | Trigger | Job |
|---|---|---|
| ~~`inbox-drain.cjs`~~ | — | ✅ DELETED in M4a (2026-06-04) with the `agent_inbox` tables it drained (writer-less since slice 017). |
| `event-capture.cjs` | UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop, SessionEnd, StopFailure, Notification | Captures all CC lifecycle events. |
| `ask-intercept.cjs` | PreToolUse on `AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode` | Intercepts ask/plan tool calls. |
| `path-guard.cjs` | PreToolUse/PostToolUse on Agent/Task + file tools | Enforces path boundaries (gate-workflow, bind/unbind, enforce). |
| `pc-statusline.cjs` | statusLine command | Renders the status line. |

> ☠ **Hook template trap (burned once):** The hook `.cjs` files live in `templates/.claude/hooks/` — that is the only real location. `packages/runtime/src/hook-scripts/` does **not** exist. Always edit `templates/.claude/hooks/`.

> ✅ **`inbox-drain.cjs` blocker — resolved (M4a 2026-06-04):** hook + tables deleted whole (migration 0041 archive; no refactor was needed — the tables were writer-less since slice 017). `legacy-runtime-cleanup.ts` keeps the hook NAME to scrub it from old installs.

---

### 9. The project registry

An in-memory map of `project ULID → ProjectRuntime` (`project-registry.ts`). Loaded from the DB at server boot (`loadAll()`). When a project is created, `register()` is called immediately after the DB insert, so the project is live in memory without a restart. `ensure()` lazily hydrates any project not yet loaded.

---

## How it connects

- **Depends on:** `@pc/runtime` (binary resolution) · `@pc/db` (settings, project rows, live events) · `@pc/domain` (Stage, GlobalSettings types) · `project-scaffold.ts` · `claude-runtime-bundle.ts` (called by spawn path) · `project-runtime.ts` + `ProjectRegistry`.
- **Used by:** `App.tsx` (mounts the first-run gate) · `POST /api/projects` (wraps `ProjectCreate.create`) · every `claude.exe` spawn path (`LowLevelSpawn`, `InteractiveSession`, `AgentRun`) calls `prepareClaudeRuntimeFiles`.
- **Events crossed:** `GlobalSettings.onboardingCompletedAt` (the gate flag) · `Project` row + `persistCreatedProjectWithLiveEvent` (DB insert + live WS event) · `setup-wizard-state` / `setup-wizard-exit` WS envelopes · `project-claude-md` live-store signature (triggers modal auto-close).

---

## Target shape (per north star + Foundation Decisions)

The consolidation ledger has no explicit row for this subsystem — it has no lifecycle ownership or process concerns and is not in the five-role migration path.

**Changes from Foundation Decisions (locked 2026-06-03):**
- ☠ **The project setup wizard is deleted (FD-21)** — no Engine migration, no modal; the orchestrator writes `CLAUDE.md` by conversation. The first-run wizard stays.
- **Preflight moves to an exact version pin (FD-22):** one tested Claude Code version pinned in code · preflight checks exact match (not ≥ floor) · installer installs exactly that version · PC disables Claude's auto-updater for spawned sessions · mismatch = loud warning + one-click install of the tested version, not a hard wall.
- **`.project-companion/` stays committed to git (FD-22 related lock):** workflows are part of the project — versioned, not gitignored. Nothing else PC writes lands in project folders.

Everything else — preflight, install, auth, project-create, scaffold, registry — maps cleanly to the target. DB is the source of truth for projects; scaffold produces durable files; session bundle produces ephemeral runtime config per spawn.

---

## Known issues / scar tissue

- **Hook template trap.** Hook `.cjs` files live in `templates/.claude/hooks/` only. `packages/runtime/src/hook-scripts/` does not exist. Burned once editing the wrong path.
- ~~**`inbox-drain.cjs` blocks legacy table deletion.**~~ ✅ resolved in M4a (2026-06-04) — hook + tables deleted.
- **`README.template.md` is stale.** Lines 8–11 list `.claude/` and `.mcp.json` as project-root files. They're not — they live in the session scratch dir. Misleading for users who read the committed README.
- **No rollback on partial scaffold.** If a `git commit` fails mid-project-create, the folder is left with partial files. `project-create.ts:30` notes atomic rollback as a followup.
- **`attach-to-git` history note.** Deleting `.project-companion/` before re-adopting is a working-tree-only delete; git history retains the old scaffold. Cosmetic only.
- **No re-entry to the wizard.** Once `onboardingCompletedAt` is set, there is no in-app way to re-run setup.

---

## Decisions & open questions

**For Emerson (product calls):**
1. **Re-run setup button?** Once onboarding is stamped complete, there's no way back in through the UI. Should there be a "Re-run setup wizard" option in global settings? If yes, does it re-check preflight only, or walk the whole flow again?
2. **Stale README in every project.** The `README.template.md` tells users `.claude/` and `.mcp.json` live in the project root — they don't anymore. Fix the template (removes confusion) or drop it from scaffold entirely (most users don't read it)?
3. **Partial-scaffold rollback.** If project creation fails mid-way, the folder is left in a broken state. Is a cleanup / retry flow worth building, or is a clear error message + manual delete good enough?

**Technical:**
- ~~`SetupWizardModal` Engine migration~~ — moot; the wizard is deleted (FD-21).
- ~~`inbox-drain.cjs` refactor timeline~~ ✅ moot — M4a deleted hook + tables (2026-06-04).
- `GET /api/preflight` has no caching contract beyond the binary-probe cache that install clears. Should preflight results have a TTL so repeated calls don't re-exec `claude --version` on every wizard render?
