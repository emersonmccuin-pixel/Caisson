# Slice 013 — Agent contracts as a first-class entity (+ work log)

> Status: planned

## Roadmap Alignment
- New feature slice (not in the original 001–012 roadmap). Inserted as 013; reverses the core premise of Section 26 (work-item-as-contract). MCP typed client stays 011, cleanup stays 012.
- Depends on slice 003 (work-item contracts + mutation gateway, verified) and slice 005 (agent-run service, durable terminal facts).
- Pairs with slice 014 (reliable-deliverable taxonomy + submission-gated verification). 013 is the safe, additive decoupling; 014 is the behavior change. **013 ships first and changes no verification behavior.**
- Design rationale + full schema: `refactor plan docs/agent-contracts-and-deliverables.md`.

## Concept
A **contract** is a first-class entity — a machine assignment with a typed, verified output — not a work item. Today it is bolted onto `work_items` (`is_agent_task`, `expected_output`, `acceptance_criteria`, `verification_*`, `assigned_agent_run_id`, `ephemeral`, `worktree_path`) and surfaced behind a "See Agent Contracts" toggle that hides those rows from the board.

This slice extracts contracts into their own table, gives the **deliverable** a home on the contract (not borrowed from `wi.body`), and makes the **work-item link optional and one-to-many**. A work item then renders its associated contracts as a **work log** — every agent that touched it, what each was asked to produce, what it delivered, whether it passed.

- Contract ↔ work item: optional FK, many contracts : one work item.
- `report` (free text to orchestrator) and `deliverable` (typed artifact) both live on the contract.
- No verification-behavior change in this slice — predicates and tiers move as-is; 014 reworks them.

## Scope (in)
- `Contract` shared contract in `@pc/contracts` (entity DTO + parsers + `contract.changed` live payload guard). `expectedOutput`/`deliverable` typed as the v2 union from the design doc (mechanisms wired for real; submission-gated enforcement is 014).
- Additive DB migration: `agent_contracts` table; nullable `agent_contracts.work_item_id` FK; `agent_runs.contract_id`. Existing `work_items` contract columns are **kept** this slice (read-through shim), removed in 014/cleanup.
- Backfill migration: one `agent_contracts` row per existing `work_items` row where `is_agent_task = 1`, copying `expected_output`/`acceptance_criteria`/`verification_*`; set `work_item_id` to that WI; set `agent_runs.contract_id` from the old `parent_work_item_id`/`assigned_agent_run_id` link.
- `ContractService` in `@pc/app-services` (get / list-by-work-item / list-by-run / create / setDeliverable / setVerification). Agent dispatch + verification read/write through it instead of the work-item contract columns.
- Route adapters: `/api/work-items/:id/contracts` (work-log read); `/api/contracts/:id` (detail). Dispatch path resolves/creates a contract.
- Durable `contract.changed` on the slice-002 outbox.
- Web: work-item inspector **Work Log** section — contract timeline rows rendered per `deliverable.kind` (answer/prose inline, repo → branch + diffstat link, external → handle + link, binary → attachment, payload → data, action → "called X"). The "See Agent Contracts" toggle becomes a read view over `agent_contracts`.
- Tests across each package.

## Scope (out)
- Submission-gated completion / `pc_submit_deliverable` (slice 014).
- The reworked predicate engine, `EvaluationContext` tool-stream, fail-closed auto-tier (slice 014; the live point-fix lands the urgent subset against current code first).
- Removing `is_agent_task`/`ephemeral`/`assigned_agent_run_id` from `work_items` (cleanup, after 014).
- Contract-without-work-item authoring UI (the FK is nullable so it's free later; no UI this slice).
- Many deliverable presets in the authoring UI (orchestrator authors via MCP; rich editor is later).

## Current-State Evidence
- `packages/domain/src/work-item-contract.ts` — `ExpectedOutput` (5 kinds), `AcceptancePredicate`, `VerificationTier/Status`. Stays until 014 supersedes it with `contract.ts`.
- `packages/db/src/schema.ts:157–182` — contract columns on `work_items`; `schema-agent-system.ts:61` — `agent_runs.parentWorkItemId`.
- `apps/server/src/services/agent-work-item.ts` — `createAgentWorkItem` (creates the WI-as-contract).
- `apps/server/src/services/agent-run-factory.ts:272–364` — dispatch resolves the contract WI, hard-fails on missing `expected_output`, sets `assignedAgentRunId` (bidirectional link).
- `apps/server/src/services/agent-run-terminal-effects.ts:190–201` — empty-result fallback reads `wi.body` as the deliverable (removed once `deliverable` lives on the contract).
- `apps/server/src/services/agent-verification.ts` — reads `wi.acceptanceCriteria`, flips the WI. Reads through the shim this slice; reworked in 014.

## Target Shape (cartridge)
```
contract (@pc/contracts: Contract DTO + parsers; contract.changed guard)
  -> db (agent_contracts table + work_item_id FK + agent_runs.contract_id + contracts repo + backfill)
  -> app-service (ContractService; dispatch + verification read/write through it)
  -> route adapters (apps/server: /work-items/:id/contracts, /contracts/:id)
  -> durable events (contract.changed) on live_outbox
  -> web (work-item inspector Work Log timeline; Agent Contracts view reads agent_contracts)
  -> tests
```

## Files
- `packages/contracts/src/contracts.ts` (new) + `contract.changed` payload guard; `work-items.ts` DTO gains nothing new (link is on the contract side).
- `packages/domain/src/contract.ts` (new — the v2 `ExpectedOutput`/`Deliverable`/predicate union from the design doc). `work-item-contract.ts` kept as a re-export shim until 014.
- `packages/db/drizzle/00XX_agent_contracts.sql` (new: table + FKs + backfill) + `packages/db/src/schema.ts` (`agentContracts`, `agentRuns.contractId`).
- `packages/db/src/repos/contracts.ts` (new); `repos/work-items.ts` (list contracts for a WI); `repos/agent-runs.ts` (contractId).
- `packages/app-services/src/contracts/service.ts` (new).
- `apps/server/src/services/agent-run-factory.ts` (resolve/create contract via ContractService); `agent-work-item.ts` (createAgentWorkItem → createContract + optional WI); `agent-run-terminal-effects.ts` (write `deliverable` to the contract; drop the `wi.body` fallback); `agent-verification.ts` (read AC from the contract).
- `apps/server/src/features/contracts/routes.ts` (new); work-item routes expose `/contracts`.
- `apps/web` — work-item inspector Work Log section + per-kind deliverable renderers; `api/contracts.ts`; Agent Contracts view reads the new endpoint.
- tests across each package.

## Compatibility Contracts
- `work_items` contract columns are **retained and dual-read** this slice. The read-through shim resolves a WI's contract from `agent_contracts` first, falling back to the legacy columns for any un-backfilled row. No reader breaks mid-migration.
- The bidirectional link is preserved through `agent_runs.contract_id` ⟷ `agent_contracts.work_item_id`; `pc_reject_work_item`'s "find the run to wake" path resolves via the contract.
- Backfill is idempotent (skip rows that already have an `agent_contracts` row).

## Migration / Rollback
- Additive migration only: new table + nullable FKs. Legacy columns untouched.
- Backfill runs once at migrate time; idempotent on re-run.
- Rollback: stop emitting `contract.changed`, hide the Work Log section (web), route reads fall back to legacy columns. The new table + FKs are inert if unused; no data loss (legacy columns still authoritative until 014 removes them).

## Tests
- Contract parser round-trips (Contract DTO, every `ExpectedOutput`/`Deliverable` kind, `contract.changed`).
- DB: migration applies; backfill produces one contract per `is_agent_task` WI with correct field copy + link; idempotent re-run; contracts repo CRUD + list-by-work-item + list-by-run.
- ContractService: create/setDeliverable/setVerification emit `contract.changed` atomically; dispatch resolves an existing contract; many-contracts-per-WI.
- Dispatch: agent-run-factory creates/links a contract; terminal effects write the deliverable onto the contract (no `wi.body` fallback); verification reads AC from the contract and still flips the WI as before (no behavior change).
- Route: `/work-items/:id/contracts` returns the timeline ordered; `/contracts/:id` detail.
- Web: Work Log renders one row per contract with the right per-kind renderer; empty state when none.

## Stop Conditions
- Do not add `pc_submit_deliverable` or change completion gating (slice 014).
- Do not rework the predicate engine, `EvaluationContext`, or auto-tier pass/fail logic (slice 014; the urgent subset is the live point-fix).
- Do not remove the legacy `work_items` contract columns (cleanup, after 014).
- Do not build contract-without-work-item authoring UI.
- Keep verification behavior byte-identical to pre-slice — this slice only moves where the data lives.

## Tracker Update
- Mark `build-slices/013-agent-contracts-first-class.md` planned in `refactor-tracker.md`.
- Session rows 44 (plan — this doc) / 45 (build) / 46 (human review) in `refactor-session-tracker.md`.
