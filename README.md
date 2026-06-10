# Caisson

**An AI-native project management platform, and a harness that builds harnesses.**

Caisson is a local desktop app where you run your projects with a team of AI specialists you build yourself. Describe the experts you need and the process that connects them, in plain English, and Caisson stands up the scaffolding that turns a raw model into something that does the job, repeatedly, in your real systems.

A board, a project manager that dispatches the work, and a roster of experts behind it. The catch: the manager and the workers are AI, and you direct them. It's built to drive agents through complex, multi-step tasks and sustain long-running agentic work: not one-shot answers, but jobs that plan, execute, verify, and report back over time.

The proof that it works: **Caisson builds itself.** It's the daily driver I use to develop Caisson. Bugs and polish become work items, its own build team plans/fixes/tests them, and the fix lands back in the app I'm using.

[![Latest release](https://img.shields.io/github/v/release/emersonmccuin-pixel/Caisson?label=download&sort=semver)](https://github.com/emersonmccuin-pixel/Caisson/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Platform: Windows · macOS](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS-0078D6)](https://github.com/emersonmccuin-pixel/Caisson/releases/latest)

> ### ⬇️ Download
>
> These links always point to the **newest release** ([changelog & older versions](https://github.com/emersonmccuin-pixel/Caisson/releases)):
>
> - **Windows:** [download the installer](https://github.com/emersonmccuin-pixel/Caisson/releases/latest/download/Caisson-latest-win-x64.exe). Not code-signed yet, so SmartScreen will warn you; click **More info → Run anyway**.
> - **macOS (Apple Silicon):** [download the installer](https://github.com/emersonmccuin-pixel/Caisson/releases/latest/download/Caisson-latest-mac-arm64.dmg). Signed and notarized; opens normally.

---

![Caisson: talk to an orchestrator that runs your project, with a team of specialists behind it](docs/images/00-hero.png)

## A look at it

| The board | A workflow, visualized |
| --- | --- |
| ![The board](docs/images/02-board.png) | ![A workflow](docs/images/03-workflow-builder.png) |

| Your roster of specialists | A task, inspected |
| --- | --- |
| ![Specialists](docs/images/04-specialists.png) | ![Work item inspector](docs/images/05-work-item.png) |

## What it costs

Your existing Claude subscription: same login, same plan. Caisson drives the interactive Claude CLI directly. No separate API key, no per-token charge.

## For developers

<details>
<summary>Setup, local run, and desktop builds</summary>

A TypeScript monorepo: an API server (`apps/server`), a React web UI (`apps/web`), an Electron desktop shell (`apps/desktop`), and shared packages for the domain model, database, workflow engine, agent host, and the MCP tool server. Local-first: everything lives in a single SQLite database on your machine.

**Prerequisites:** Node 22 · pnpm 10.33.0 · Git · Claude Code CLI (to run the product end-to-end).

```powershell
git clone https://github.com/emersonmccuin-pixel/Caisson.git
cd Caisson
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

Run locally (API on `http://127.0.0.1:4040`, Vite frontend on `http://127.0.0.1:5173`):

```powershell
pnpm dev
pnpm --filter @pc/web dev
```

Desktop builds:

```powershell
pnpm desktop:dist:dir   # local package smoke
pnpm desktop:dist:win   # Windows installer (built on Windows)
pnpm desktop:dist:mac   # macOS DMG/ZIP (built on macOS, needs Apple signing secrets)
```

</details>

## License

MIT. See [LICENSE](./LICENSE).
