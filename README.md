# Caisson

**Build a team of AI specialists that run real work in your real systems — by describing them in plain English.**

Caisson is a local desktop app where you assemble a team of AI specialists, automate the workflows that connect them, and put both to work in the systems you already run. It's a harness that builds harnesses: you describe the expert and the process, and Caisson stands up the scaffolding that turns a raw model into something that does the job, repeatedly, in your real stack.

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

## What it is

Real leverage from AI is gated by tech fluency. The people who know how to wire up an MCP server, write a system prompt, and hand a model real API access turn it into a teammate that operates their stack. Everyone else gets a chat box and re-explains their job every morning.

Caisson closes that gap. The person who knows the work (the analyst who knows the warehouse, the engineer who knows the codebase, the ops lead who knows the runbook) describes how it should be done, once. Caisson builds the harness around it: the role, the tools and credentials, the context that normally lives in your head. From then on the specialist carries the load, operating your real systems directly through their APIs, running the queries, shipping the code, filing the tickets, watching for what changed.

It's not a chat window you start over in every morning. It's a standing team you assemble, direct, and grow, running on your machine, on your own Claude subscription.

Two things it lets anyone do without writing code:

- **Build a team of agents.** Describe an expert in plain English (what it knows, what it can reach, how you want the work done) and Caisson stands it up. No prompt engineering, no MCP plumbing, no YAML.
- **Automate your workflows.** Chain specialists and tools into a process with a trigger and a verified output. Set it up once in conversation; it runs the same way every time.

## It builds itself

The clearest demonstration of Caisson is that it's self-hosted. I run it every day as the daily driver, and its own specialists ship its development:

1. **Use the app:** orchestrator chat, agent dispatch, workflows, the board.
2. **Capture a bug or rough edge as a work item** the moment you hit it.
3. **The build workflow picks it up:** a code-writer plans, writes, typechecks, and tests the change against a contract; a reviewer checks the result.
4. **The fix lands back in the app you're using.** Close the loop, repeat.

A harness that builds harnesses, pointed at itself. The build team that ships Caisson's own fixes is the same machinery you get to build *your* team.

## What a specialist can be

A specialist is an expert you configure: a focused role, the tools and credentials it needs, and the context that normally lives in your head. A few shapes the same machinery takes:

**A data team.** A Snowflake / Redshift specialist with warehouse credentials, the query tools, and your semantic-layer rules: what "active user" means, where the data lives, how you'd actually answer. It runs the recurring analyses and writes up what changed, without you re-explaining the schema every time.

**A platform / ops team.** Specialists wired into AWS, GCP, and your CI, handling the routine work (provisioning to spec, checking for drift, triaging the standard alerts) and escalating the calls that need a human.

**A build team.** A code-writer that plans, writes, typechecks, and tests a change against a contract, with a reviewer checking the result. A bug or feature goes from a card to a verified diff. *(This is the team that builds Caisson.)*

**A delivery team.** Specialists connected to Jira / Atlassian that triage inbound, groom the board, draft the specs, and run the status roll-ups.

And the lighter end of the same engine: a sales rep whose specialist drafts post-call follow-ups in their voice; an HR coordinator whose onboarding runs itself out into a task tree. **Same tool — the ceiling is as high as the access you give it.** None of these ship as canned templates; you build the team *you* need by describing it.

## A look at it

| The board | A workflow, visualized |
| --- | --- |
| ![The board](docs/images/02-board.png) | ![A workflow](docs/images/03-workflow-builder.png) |

| Your roster of specialists | A task, inspected |
| --- | --- |
| ![Specialists](docs/images/04-specialists.png) | ![Work item inspector](docs/images/05-work-item.png) |

## How you build it

You have a conversation. An interview walks you through it, for both **specialists** and **workflows**:

- **What is it expert in?** The role, in your words.
- **What can it reach?** The tools, API access, and credentials it needs to operate your systems.
- **What context does it need?** The rules, definitions, and runbook that live in your head.
- **What triggers the work?** A schedule, an external event, a manual run, or a task crossing a stage on the board.
- **What does "done" look like?** Shipped automatically, drafted for your approval, filed as a task, or routed to someone for sign-off.

You answer in plain English. Caisson writes it. Want a change? Tell it in the same chat and it adjusts. No prompts, no YAML, no code.

## How it's built

The interesting engineering is in making agent work *trustworthy*. Agents that hang, lie about finishing, or quietly stomp each other are the default failure mode, and Caisson is built to refuse all three.

| Piece | What it is |
| --- | --- |
| **Specialists** | Expert agents with their own role, model, tools, credentials, and context. Dispatchable, and every run is audited. |
| **Tools & integrations** | How specialists reach the outside world (the MCP tool layer). Hand one the right tools and credentials and it drives that system's API: query a warehouse, open a PR, file a ticket, call a cloud control plane. |
| **Workflows** | A trigger plus a series of steps plus a verified output. Steps dispatch specialists, call tools, move work across the board, or pause for your sign-off. |
| **The board** | Tasks are the universal primitive. A workflow run produces a tree of them; the kanban board is one view of that tree. |

Four principles keep it honest:

- **Contracts + isolation.** Every dispatch carries a machine-checkable contract (what the output must be and how to verify it), and when isolation is declared it runs in its own provisioned git worktree or refuses to start. "Done" means *verified done*, and parallel agents can't corrupt each other's work.
- **Positive receipt, never inference.** Done / ready / paused are explicit signals. A timeout or crash produces a typed failure *with a reason*, never a silent hang, never a fake success.
- **One path only.** A refactor deletes the old path; no dual processes doing the same job, guarded by single-path tests. Discipline as a feature.
- **The database is the source of truth.** Everything durable lives in one local SQLite database. Runtime processes emit facts; the UI projects them. Local-first, fully yours.

## Your starting team

Every project ships with nine built-in specialists as a starting kit. The Project Manager dispatches work to them; edit them, add your own wired to your systems, or promote a good one to use across all your projects.

| Specialist | What it's for |
| --- | --- |
| **researcher** | Investigates on demand (reads files, fetches the web) and writes up findings |
| **writer** | Drafts prose (emails, docs, summaries) in your voice |
| **reviewer** | Critiques drafts, plans, or code against explicit criteria |
| **planner** | Breaks a goal into ordered, verifiable steps |
| **extractor** | Pulls structured data out of messy input |
| **code-writer** | Writes or edits code to spec, then typechecks and tests it |
| **workflow-builder** | Authors and edits your workflows through the build conversation |
| **agent-designer** | Designs new specialists from a plain-language description |
| **caisson** | The in-app guide: explains how Caisson works and adjusts your settings |

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
