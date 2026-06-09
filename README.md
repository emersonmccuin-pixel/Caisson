# Caisson

**Build your own team of AI specialists — by talking, not coding.**

[![Latest release](https://img.shields.io/github/v/release/emersonmccuin-pixel/Caisson?label=download&sort=semver)](https://github.com/emersonmccuin-pixel/Caisson/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)](https://github.com/emersonmccuin-pixel/Caisson/releases/latest)

> ⬇️ **Just want to use it?** Grab the Windows installer from the [latest release](https://github.com/emersonmccuin-pixel/Caisson/releases/latest). It's not code-signed yet, so SmartScreen will warn you — click **More info → Run anyway**.

---

![Caisson — tasks on the board](docs/images/02-board.png)

## What it is

Caisson is a harness that lets anyone in a company — technical or not — turn the repetitive parts of their job into AI agents and workflows, just by describing them.

The result is a personal **team of specialists** that know your work and run it the way you would: a researcher, a writer, a reviewer, a data analyst — each an expert in one area, each on call.

You don't write prompts, YAML, or code. You have a conversation with a per-project **AI Project Manager**, and it builds the agents and workflows for you. It runs entirely on your machine, on your own Claude subscription.

## The problem it solves

AI at work is gated by tech fluency. The people who know what `CLAUDE.md` is, how to write a skill, how to wire up an MCP server — they get real leverage. Everyone else gets a chat window and starts over every conversation.

Caisson closes that gap. You describe how the work should be done, in plain English; Caisson captures it once and runs it forever. The person who knows the job is the one operating the tool.

## Who it's for

Anyone with repetitive, judgment-light work they'd rather not redo by hand. Three examples:

**A developer.** Bugs and small features pile up. He captures each as a card. A workflow hands it to the **code-writer** specialist with a contract — *must typecheck and pass tests before it counts as done* — and the **reviewer** checks the result against his criteria. He gets a verified fix to look over instead of a blank editor. *(This is literally how Caisson builds itself.)*

**An HR coordinator.** Every new hire means the same checklist: welcome email, first-week plan, accounts to request, forms to collect. She describes onboarding once. Running it lays the whole task tree out on the board, and the **writer** drafts the welcome note in the company's voice — she reviews and sends, instead of rebuilding it per hire.

**A salesperson.** After every call she does the same thing: read the transcript for questions and objections, match them to her standard answers, write a follow-up in her voice. She drops in the transcript; a specialist reads it, the **researcher** pulls what she needs on the account, and the **writer** drafts the email for her to send — twenty minutes after the call, not two days.

None of these are canned templates. Each person builds the one *they* need by describing it.

## A look at it

| The project chat — your front door | Workflows, with their triggers |
| --- | --- |
| ![The project chat](docs/images/01-orchestrator-chat.png) | ![A workflow](docs/images/03-workflow-builder.png) |

| Your roster of specialists | A task, inspected |
| --- | --- |
| ![Specialists](docs/images/04-specialists.png) | ![Work item inspector](docs/images/05-work-item.png) |

## How you build it

You have a conversation. An interview walks you through it — both for **workflows** and for **specialists**:

- **What should it do?** In your words.
- **What triggers it?** A schedule, an external event, a manual click, or a task crossing a stage on the board.
- **What has to happen?** The steps.
- **What does it need?** Credentials, API keys, tools to reach external systems.
- **What does "done" look like?** Drafted for your approval, auto-sent, filed as a task, or routed to someone for sign-off.

You answer in plain English. Caisson writes it. Want a change? Tell it — same chat — and it adjusts.

## Your starting team

Every project ships with nine specialists. The Project Manager dispatches work to them; edit them, add your own, or promote a good one to use across all your projects.

| Specialist | What it's for |
| --- | --- |
| **researcher** | Investigates on demand — reads files, fetches the web — and writes up findings |
| **writer** | Drafts prose (emails, docs, summaries) in your voice |
| **reviewer** | Critiques drafts, plans, or code against explicit criteria |
| **planner** | Breaks a goal into ordered, verifiable steps |
| **extractor** | Pulls structured data out of messy input |
| **code-writer** | Writes or edits code to spec, then typechecks and tests it |
| **workflow-builder** | Authors and edits your workflows through the build conversation |
| **agent-designer** | Designs new specialists from a plain-language description |
| **caisson** | The in-app guide — explains how Caisson works and adjusts your settings |

## What a workflow is

A **trigger** + a series of **steps** + a **verified output.**

Steps can dispatch a specialist, call an external tool, move a task across the board, or pause for your approval. When work is handed to a specialist, Caisson attaches a contract — what the output should be and how to tell it's right — and checks the result against it. "Done" means *verified done*, and the output lands where you said it should.

## Status — v0.1.0

First published release — pre-1.0, under active development.

- ✅ **Live now:** the project chat, the board, conversational workflow building, the specialist roster, agent dispatch with verified contracts, the packaged Windows app.
- 🔜 **Modeled, UI coming:** schedule and event triggers, full human-in-the-loop review gates.
- 🪟 **Windows-first.** The macOS build path exists but isn't part of this release.

Schemas and APIs may still change between releases.

## What it costs

Your existing Claude subscription — same login, same plan. Caisson drives the interactive Claude CLI directly. No separate API key, no per-token charge.

## For developers

<details>
<summary>Setup, local run, and desktop builds</summary>

A TypeScript monorepo: an API server (`apps/server`), a React web UI (`apps/web`), an Electron desktop shell (`apps/desktop`), and shared packages for the domain model, database, workflow engine, agent host, and the MCP tool server. Local-first — everything lives in a single SQLite database on your machine.

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
