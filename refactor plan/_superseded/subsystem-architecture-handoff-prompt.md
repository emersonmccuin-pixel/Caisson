# Subsystem Architecture Handoff Prompt

Use this prompt to create repeatable subsystem analysis documents that can later be handed to another agent for implementation planning and build work.

## Output Location

- Put each subsystem document in `refactor plan/refactor plan docs/`.
- Use this filename pattern: `{subsystem-slug}.md`.
- After each subsystem document is created, update `refactor plan/refactor-tracker.md`.
- Do not put subsystem refactor plans in `archive/`, `docs/`, or ad hoc folders.

## Target Architecture Context

- Read `refactor plan/target-architecture.md` before writing any subsystem document.
- Treat it as the north-star architecture, not as current implementation truth.
- Use it to evaluate alignment, gaps, conflicts, and migration direction.
- Do not assume the target architecture has been implemented unless verified in code.
- If the target architecture conflicts with current subsystem findings, document the conflict instead of silently resolving it.

## Core Rule

Subsystem documents are evidence and proposals.

The target architecture document is the north star.

The holistic synthesis document is the reconciliation layer.

The implementation roadmap is the commitment.

## Repository Rules

- Analyze the current codebase only.
- Do not change implementation code.
- Do not restart servers or the app.
- Do not assume recommendations from previous subsystem documents have been implemented unless they are already present in code.
- Treat previous subsystem documents as context, dependency clues, and proposed futures, not as current architecture.
- Treat `refactor plan/target-architecture.md` as desired direction, not current architecture.
- Clearly separate verified behavior, inferred behavior, local recommendations, cross-subsystem considerations, and open questions.

## Repository Exclusion

Ignore `archive/` entirely in whichever checkout is being analyzed, including:

- `E:\Claude Code Projects\Personal\PC-PTY-Chat\archive`
- `E:\Claude Code Projects\Personal\PC-PTY-Chat-codex\archive`

Do not search it, read it, cite it, or use it as evidence.

If a search tool returns results from `archive/`, discard them.

When using `rg`, exclude it:

```powershell
rg "pattern" --glob "!archive/**"
rg --files --glob "!archive/**"
```

## Subsystem Document Prompt

```md
Create a subsystem architecture and implementation handoff document.

Subsystem: {SUBSYSTEM_NAME}
Reason for analysis: {WHY_WE_ARE_DOING_THIS}
Output path: refactor plan/refactor plan docs/{SUBSYSTEM_SLUG}.md
Tracker path: refactor plan/refactor-tracker.md
Target architecture path: refactor plan/target-architecture.md
Prior subsystem docs to consider as context only: {PRIOR_DOC_PATHS}
Intended next step: another agent will use this document to create an implementation plan and then build the changes.

Rules:
- Work from the codebase, existing docs, tests, config, and runtime boundaries.
- Read `refactor plan/target-architecture.md`.
- Analyze against the current codebase only.
- Do not assume recommendations from previous subsystem documents have been implemented unless verified in code.
- Treat prior subsystem docs as proposed futures and dependency clues, not implemented truth.
- Treat the target architecture as north-star direction, not implemented truth.
- Ignore `archive/` entirely. Do not search it, read it, cite it, or use it as evidence.
- Do not change implementation code.
- Do not restart servers or the app.
- Ground claims in source references where possible.
- Clearly label verified facts, inference, recommendations, and open questions.
- After creating the subsystem document, update `refactor plan/refactor-tracker.md`.

The document must be actionable enough that another agent can plan and implement from it without rediscovering the whole subsystem.

Include:

1. Executive Summary
- What this subsystem does.
- Why it matters.
- Current health of the subsystem.
- High-level recommendation.

2. Baseline
- Date.
- Branch.
- Commit hash.
- Codebase state: current implementation only.
- Assumed implemented recommendations from other docs: none, unless verified in code.
- Excluded paths: `archive/`.

3. Scope and Non-Goals
- What is included in this subsystem.
- What adjacent systems are explicitly out of scope.
- What should not be changed casually.

4. Current System Trace
- Trace how the subsystem works today from entry points to final outputs.
- Include key files, functions, classes, endpoints, IPC events, stores, database tables, queues, configs, and runtime processes.
- Document normal flow, failure flow, startup/shutdown behavior, and important edge cases.

5. Integration Map
- List all inbound integrations.
- List all outbound integrations.
- Document contracts, shared state, side effects, assumptions, and failure boundaries.
- Identify tight coupling and hidden dependencies.

6. Data and State Model
- Document what state the subsystem owns.
- Document what state it reads or mutates elsewhere.
- Include schemas, persistence, cache behavior, lifecycle, cleanup, and concurrency concerns.

7. Invariants and Compatibility Requirements
- List behaviors that must remain true after refactor.
- List public/internal contracts other subsystems rely on.
- List compatibility constraints for migration.

8. Related Subsystem Docs
For each related doc include:
- Related subsystem.
- Current dependency verified in code.
- Recommendation in that doc.
- Does this doc assume that recommendation is implemented? no.
- Potential conflict.
- Coordination needed.

9. Current Issues
For each issue include:
- Severity: critical / high / medium / low.
- Evidence.
- Impact.
- Likely root cause.
- Suggested fix direction.
- Affected files/systems.

10. First-Principles Design
- Describe what this subsystem should look like if designed from scratch.
- Define ideal responsibilities, boundaries, APIs, data model, lifecycle, error handling, observability, and test strategy.
- Then explain how this ideal must fit into the existing app.

11. Target Architecture Alignment
- Compare the local first-principles design to `refactor plan/target-architecture.md`.
- Identify where this subsystem aligns with the target cartridge shape:
  - contracts;
  - domain;
  - db repo;
  - application service;
  - HTTP route;
  - live events;
  - web client/hooks;
  - MCP adapter when relevant;
  - tests.
- Identify where this subsystem touches target cross-cutting systems:
  - shared contracts;
  - canonical live events;
  - durable mailbox;
  - runtime host boundary;
  - MCP adapter boundary;
  - UI fetch discipline.
- Document gaps between current implementation and target architecture.
- Document conflicts or uncertainties that need holistic synthesis.

12. Recommended Target Architecture
- Propose the practical architecture to build toward.
- Identify what should be kept, replaced, split, merged, or deleted.
- Define module boundaries and ownership.
- Define integration contracts with the rest of the app.
- Mark decisions that require holistic synthesis instead of local resolution.

13. Migration Strategy
- Provide an incremental path from current state to target state.
- Break work into safe phases.
- For each phase include:
  - Goal.
  - Files likely affected.
  - Dependencies.
  - Risks.
  - Verification.
  - Rollback notes.
  - Whether restart/reload is required.

14. Acceptance Criteria
- Functional criteria.
- Integration criteria.
- Regression criteria.
- Observability/debuggability criteria.
- Performance or reliability criteria if relevant.

15. Test Plan
- Existing tests that cover the subsystem.
- Missing tests.
- Required unit tests.
- Required integration tests.
- Manual verification steps.
- Known hard-to-test areas.

16. Implementation Notes for Next Agent
- Recommended starting point.
- Suggested order of work.
- Risky areas to inspect before editing.
- Files/symbols most likely to change.
- Existing patterns to follow.
- Things to avoid.

17. Handoff Metadata
- Subsystem.
- Primary owner area.
- Runtime process.
- Owns state.
- Reads state from.
- Writes state to.
- Inbound contracts.
- Outbound contracts.
- Hard dependencies.
- Soft dependencies.
- Restart required for changes.
- Migration risk.
- Target architecture status: keep / refactor / replace / delete / split / merge.
- Related docs consulted.

18. Tracker Update
- Add or update the row for this subsystem in `refactor plan/refactor-tracker.md`.
- Link to the new subsystem document.
- Fill status, baseline branch, baseline commit, owner area, runtime process, migration risk, target recommendation, dependencies, and open questions.
- Add any newly discovered subsystem candidates to the tracker as `not started`.

19. Open Questions
- True blockers.
- Non-blocking uncertainties.
- Product/design decisions needed.
- Technical decisions the builder can reasonably make.

Style:
- Be direct and specific.
- Prefer bullets and tables.
- Avoid vague recommendations.
- Use exact code references.
- Separate verified facts from inference.
```

## How To Process The Nth Subsystem

When analyzing the second, third, or later subsystem:

1. Establish the baseline.
- Check current branch and commit.
- Record that current code is the only implementation truth.
- Record that previous recommendations are not assumed implemented.

2. Read target architecture.
- Read `refactor plan/target-architecture.md`.
- Use it as north-star direction.
- Do not use it as current-state evidence.
- Track alignment, gaps, and conflicts.

3. Read prior subsystem docs as context only.
- Look for boundaries, integrations, proposed futures, terminology, and possible conflicts.
- Do not redesign this subsystem around hypothetical future changes.

4. Inspect current code.
- Locate files for the subsystem.
- Trace imports, calls, IPC, API routes, events, stores, database access, filesystem access, background processes, config, and tests.
- Exclude `archive/`.

5. Trace current behavior.
- Startup path.
- Main user/action flow.
- Data flow.
- Error flow.
- Shutdown/cleanup flow when relevant.
- Edge cases.
- State ownership and mutation.

6. Build the integration map.
- Who calls this subsystem.
- What this subsystem calls.
- What state crosses boundaries.
- What contracts and side effects exist.

7. Compare against prior docs and target architecture.
- Check whether this subsystem interacts with earlier subsystems.
- Check whether prior docs describe the dependency differently.
- Check for conflicting ownership claims.
- Check for duplicate sources of truth.
- Check whether the subsystem can move toward the target cartridge shape.
- Check whether target architecture assumptions conflict with current code.
- Record conflicts instead of silently resolving them.

8. Write local recommendations.
- Keep recommendations local to this subsystem.
- Mark global architecture decisions for synthesis.
- Include acceptance criteria, tests, migration phases, risks, and restart/reload implications.
- Update `refactor plan/refactor-tracker.md`.

## Holistic Architecture Synthesis Prompt

Use this after several subsystem documents exist.

```md
Create a holistic architecture synthesis document from the subsystem handoff documents.

Input documents:
{LIST_OF_SUBSYSTEM_DOC_PATHS}

Target architecture:
refactor plan/target-architecture.md

Tracker path:
refactor plan/refactor-tracker.md

Output path:
refactor plan/holistic-architecture-synthesis.md

Purpose:
This document will be used by another agent to create an implementation roadmap across many subsystems. It must reconcile subsystem recommendations into one coherent app architecture.

Rules:
- Read all subsystem documents first.
- Read `refactor plan/target-architecture.md`.
- Read `refactor plan/refactor-tracker.md`.
- Use codebase references only when needed to verify conflicts or missing context.
- Do not change implementation code.
- Do not restart servers or the app.
- Ignore `archive/` entirely.
- Clearly distinguish verified facts, subsystem-doc claims, and synthesis/inference.
- Prefer concrete contracts and migration ordering over vague architecture language.

Include:

1. Executive Summary
- Overall system health.
- Major architectural problems across subsystems.
- Recommended target direction.
- Highest-risk areas.

2. System Inventory
- List every subsystem covered.
- Summarize its purpose, runtime process, owned state, and target recommendation.
- Identify missing subsystem docs or unclear boundaries.

3. Current Architecture Map
- Describe how the app works today across desktop, web, server, channel, shared packages, persistence, orchestration, and runtime processes.
- Include major data flows and control flows.
- Include a dependency graph or adjacency list.

4. Integration Matrix
- For every subsystem, list inbound and outbound integrations.
- Identify direct calls, IPC, HTTP routes, event streams, shared stores, database access, filesystem access, process boundaries, and config dependencies.
- Mark coupling level: low / medium / high.

5. Shared State and Ownership
- Identify all shared state.
- Define current owner vs recommended owner.
- Identify duplicate sources of truth.
- Identify state that crosses process boundaries.
- Identify lifecycle, cleanup, concurrency, and persistence risks.

6. Cross-Cutting Issues
- Group repeated issues across subsystem docs.
- Identify unclear ownership, duplicated logic, hidden coupling, fragile startup order, weak error boundaries, missing observability, inconsistent contracts, inconsistent state models, and insufficient tests.

7. Architectural Invariants
- Define behaviors and contracts that must remain true during migration.
- Include runtime, UX, API, data, persistence, and compatibility constraints.
- Note which subsystems rely on each invariant.

8. Target System Architecture
- Describe the intended holistic architecture.
- Define subsystem boundaries.
- Define ownership of state, APIs, events, lifecycle, errors, and observability.
- Define dependency direction rules.
- Identify what should be kept, split, merged, replaced, or deleted.

9. Contract Registry
- Define important contracts between subsystems.
- Include APIs, IPC messages, events, schemas, stores, config, files, and process lifecycle expectations.
- Identify contracts that need formalization before implementation.

10. Conflict Resolution
- Identify recommendations from subsystem docs that conflict.
- Explain each conflict.
- Recommend the resolution.
- Document tradeoffs.

11. Migration Roadmap
- Produce an ordered multi-phase roadmap across all subsystems.
- For each phase include:
  - Goal.
  - Subsystems affected.
  - Dependencies.
  - Required compatibility shims.
  - Tests needed.
  - Rollback strategy.
  - Restart/reload requirement.
  - Risk level.

12. Implementation Sequencing
- Identify what must happen first.
- Identify what can happen in parallel.
- Identify what should wait.
- Identify risky edits that need isolated PRs or checkpoints.

13. Test and Verification Strategy
- Define system-level tests needed.
- Define integration tests across subsystem boundaries.
- Define manual dogfood checks.
- Identify gaps in existing test coverage.
- Define verification after each migration phase.

14. Observability and Debuggability
- Recommend logging, tracing, metrics, health checks, dev diagnostics, and failure visibility across the system.
- Identify where current debugging is weak.

15. Tracker Update
- Update `refactor plan/refactor-tracker.md` with synthesis status, conflicts found, missing docs, and roadmap phase assignments where known.

16. Open Questions and Decision Log
- List blocking decisions.
- List non-blocking uncertainties.
- Record major architecture decisions and rejected alternatives.

Style:
- Be direct and implementation-oriented.
- Prefer tables and bullets.
- Avoid repeating full subsystem details.
- Focus on connections, conflicts, ordering, and global correctness.
```
