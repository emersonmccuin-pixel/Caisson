# Proposal — make the meaningful contract fields required (close the empty-contract auto-pass)

**Date:** 2026-06-07
**Status:** IMPLEMENTED on `dev` 2026-06-07 (changes 1–3 in full; change 4 enforced at
the dispatch seam, DB-level NOT NULL deferred — see "What shipped" at the bottom).
**Origin:** a `snowflake-expert` dispatch reported `verification: passed` having checked
nothing — the contract was authored with no `expected_output`, derived to empty
acceptance criteria, defaulted to tier `auto`, and the empty-AC branch auto-accepted.

## Problem (one line)

A contract can exist, dispatch, and PASS verification while specifying nothing it
will be held to. Every field that gives a contract teeth is nullable.

## Root of it

At the storage layer (`packages/db/src/schema-agent-system.ts:127` — `agent_contracts`)
only the bookkeeping columns are `NOT NULL`: `id`, `projectId`, `status` (default
`issued`), `version` (default `1`), `createdAt`, `updatedAt`. The four fields that
define what the contract *means* are all nullable:

- `expected_output` (`:141`)
- `acceptance_criteria` (`:143`)
- `verification_tier` (`:144`)
- `pod_name` (`:139`)

The empty-contract path that let the bad run pass:
- spec-less dispatch → `resolveContractForDispatch` walks the default chain
  (`apps/server/src/services/agent-run-factory.ts:1119`): inline spec → pod-row default
  → stock-pod default (`packages/domain/src/pod-defaults.ts:34`) → `null`. A **custom
  pod** (e.g. `snowflake-expert`) is not in the stock table, so the chain ends in `null`.
- `null`/bare-`answer` spec → `deriveAcceptanceCriteriaV2` yields `[]`
  (`packages/domain/src/ac-derivation.ts:50`).
- empty AC + tier defaults to `auto` (`apps/server/src/services/agent-verification.ts:150`).
- the fail-closed guard only covers `action`/`external`/`repo`
  (`KINDS_REQUIRING_EVIDENCE`, `ac-derivation.ts:23`), so `answer` falls to the
  "empty AC = trust the agent → accept" branch (`agent-verification.ts:227`).

## The four changes

### 1. `expected_output` — required at dispatch

**Now:** optional in the tool schema (`packages/domain/src/tool-registry.ts:1501`,
`required: ["name","input"]`); handler treats absent as `undefined`
(`packages/mcp/src/tools/agent-runs.ts:53`); the factory back-fills from defaults or
`null`.

**Proposed:** a dispatch must resolve a non-null `expected_output`. Keep the default
chain (inline → pod-row → stock) as the *resolution* mechanism, but when it ends in
`null`, **reject the dispatch** with a typed failure instead of minting a null-spec
contract. A pod with no stock/row default must be dispatched with an explicit
`expected_output`.

**Surface:** `resolveContractForDispatch` (`agent-run-factory.ts:1106`) — the
`expectedOutput = ... ?? null` branch becomes a hard fail; add a `cause:
'expected-output-required'` to `DispatchAgentFailure`. Mirror the message in the tool
description.

**Acceptance:** dispatching a custom pod with no spec and no pod-row default returns a
typed refusal (not a passing run); existing stock-pod dispatches are unaffected (they
resolve a default).

### 2. `acceptance_criteria` — never an auto-passing empty set

**Now:** derived; `[]` for a side-effect-free kind auto-accepts
(`agent-verification.ts:227`). Fail-closed only for `action`/`external`/`repo`.

**Proposed:** extend fail-closed to **every** kind. An empty derived AC should escalate
to review (tier-2 `pending`) rather than auto-accept — for `answer`/`prose`/`payload`/
`binary` too. "Trust the end-of-turn" should be an explicit opt-in on the spec, not the
silent default.

**Surface:** `agent-verification.ts:197-229` — drop the unconditional empty-AC accept;
route empty-AC to the same escalate-to-`pending` path the evidence kinds use. Decide
the opt-in token (e.g. `answer` with an explicit `trust_end_turn: true`) if we want to
preserve the degenerate-answer pods (`agent-designer`, `workflow-builder`, `caisson` —
`pod-defaults.ts:81-89`).

**Acceptance:** a bare-`answer` contract with no `must_address`/`min_chars` no longer
reports `passed` with zero predicates; it lands in `verifying`/`pending` for the
orchestrator to sign off.

> Note: `acceptance_criteria` is *derived*, not hand-authored, so this is a derivation/
> verification fix, not a "make the orchestrator type it" change.

### 3. `verification_tier` — explicit, not a silent default

**Now:** nullable; `agent-verification.ts:150` defaults `null → 'auto'` invisibly.
`auto` + empty AC is the silent-pass combination.

**Proposed:** require an explicit tier on every contract at create time (default it
explicitly in `resolveContractForDispatch` / the pod default, so it is always a written
value on the row — never an implicit fallback decided at verification time). Surface it
in `pc_get_contract` so the agent sees who signs off.

**Surface:** `agent-run-factory.ts:1152` (pass a concrete tier into
`service.create`, don't leave `?? null`); keep `agent-verification.ts:150` as a defensive
fallback only.

**Acceptance:** every new `agent_contracts` row has a non-null `verification_tier`.

### 4. `pod_name` — required

**Now:** nullable (`schema-agent-system.ts:139`).

**Proposed:** a dispatched contract always has a producing pod; require it at create.
(Low-risk — the dispatch path already knows the pod name; this is closing a
theoretical null.)

**Surface:** `agent-run-factory.ts:1146` passes `podName: args.podName` already; make
the column `NOT NULL` via migration and assert non-empty in `ContractService.create`.

## Lifecycle fields — required at the right *stage*, not at create

These can't be required at creation (the system fills them in), but each has a stage
where it must exist:

- `agent_run_id` — required once dispatched. **Already enforced** — a run can't spawn
  contract-less (`agent-run-factory.ts:460`, `cause: 'contract-required'`).
- `deliverable` — required at terminal. **Already enforced** — a contract-first run that
  reaches terminal without `delivered_at` is a `no-deliverable` failure
  (`schema-agent-system.ts:87`).
- `verification_status` / `verification_notes` — system-managed at terminal. No change.
- `report` — free text. No change.

## Migration

`agent_contracts` is JSON-column-heavy; the only NOT NULL changes are `pod_name`
(change 4) and — if we choose to enforce at the storage layer rather than the service
layer — `verification_tier` (change 3). `expected_output`/`acceptance_criteria` stay
nullable in SQLite (the invariant is enforced at the dispatch/verification seams, which
is where the typed failures live). Back-fill existing null `pod_name` rows from their
linked `agent_runs.pod_name` before the ALTER.

## Test surface

- `packages/db/test/contracts.test.ts` — null-spec create now rejected/escalated.
- `apps/server/test/verification-slice-020.test.ts` — empty-AC `answer` no longer
  auto-passes.
- new: spec-less custom-pod dispatch returns the typed refusal.
- new: every created contract row carries a non-null tier.

## What shipped (2026-06-07, on `dev`)

Files changed:
- `packages/domain/src/contract.ts` + `packages/contracts/src/contracts.ts` — added
  `trust_end_turn?: boolean` to the `answer` spec.
- `packages/domain/src/pod-defaults.ts` — set `trust_end_turn: true` on the three
  degenerate-answer stock pods (agent-designer, workflow-builder, caisson).
- `apps/server/src/services/agent-run-factory.ts` — `resolveContractForDispatch` gains
  `requireExpectedOutput`; fresh dispatch sets it and aborts (no spec-less contract);
  `verificationTier` written as `'auto'` explicitly; refined the abort message.
- `apps/server/src/services/agent-verification.ts` — bare `answer` with empty AC and no
  `trust_end_turn` escalates to review instead of auto-accepting.
- `packages/domain/src/tool-registry.ts` (+ regenerated `packages/mcp/test/__golden__.json`)
  — `pc_invoke_agent` `expected_output` description updated.
- Tests added in `dispatch-contract-resolve.test.ts` and `verification-slice-020.test.ts`.

Verification: `pnpm -r typecheck` green; full `apps/server` suite (382), plus db/mcp/
domain/app-services contract+verification suites, all pass.

### Deviation — change 4 (`pod_name`)

Not enforced via a DB `NOT NULL` migration. Reason: SQLite NOT NULL requires a full
table rebuild, and the daily-driver DB has a history of migration-ledger fragility
(`reference_drizzle_ledger_lies_fresh_db_crash`). The value of closing a *theoretical*
null didn't justify that risk. Instead `pod_name` is guaranteed non-empty for every
**dispatched** contract by the existing MCP-layer validation (`pc_invoke_agent` rejects
empty `name`) — so the dispatch path, the only one that produces verified contracts,
always carries a pod name. The DB-level constraint is deferred as low-value polish.

### Note — the other contract door was already guarded

`pc_create_agent_work_item` (`apps/server/src/services/agent-work-item.ts:122`) already
hard-failed when no `expected_output` resolved. This change closes the *direct*
`pc_invoke_agent` door (the path the snowflake run used), making both doors consistent.
