# Slice 019 — Dispatch inversion (contract-first)

> Status: planned (building). Sequenced in `contract-first-build-plan.md`; trace in `refactor plan docs/contract-first-switchover-trace.md`; design Decision 1 + Decision 4 in `agent-contracts-and-deliverables.md`.
> Absorbs the 014a server-side verification wiring (it's only exercised once dispatch authors v2 contracts — landed here so the full author→verify path is live-verified together).

## Roadmap Alignment
- Depends on 013 (contract entity, done) + 014a (v2 engine + derivation, done).
- The pivot of the whole switchover: makes the **contract** the always-created spine and the **work item** an optional link. Unblocks 020 (verification flips the contract), 021 (prompts), 022 (UI), 023 (schema cleanup).

## Concept
Today a dispatch REQUIRES a work item: `agent-run-factory.ts` hard-fails if `workItemId` is missing or has no `expected_output` (270–297), overloads the run row's `parent_work_item_id` as the contract home (340–341), writes the 1:1 `assigned_agent_run_id` back-link (385), and `resolveContractForDispatch` returns null when there's no WI (1187) — so **no WI ⇒ no contract**.

Invert it: a dispatch ALWAYS creates a contract carrying its own v2 `expectedOutput` + derived AC. A work item is attached only when the output needs that home — decided by the orchestrator per Decision 4, gated by a deterministic **WI-requirement policy** (built first, this slice). If an output kind requires a home and none is supplied/creatable, the dispatch is **rejected loudly**.

## Scope (in)
- **WI-requirement policy** (domain, pure). `expectedOutputRequiresWorkItem(spec)` — the deterministic table from Decision 4. **DONE** (this slice, first vertical): `packages/domain/src/work-item-policy.ts` + tests.
- **Contract authoring at dispatch.** A dispatch authors a contract with a v2 `expectedOutput` (caller-supplied, pod-default, or stock) and `deriveAcceptanceCriteriaV2`. `resolveContractForDispatch` always creates a contract; `workItemId` becomes an optional link, not the trigger (remove the `!args.workItemId → null` gate at 1187).
- **Decision-4 reject guard** at the dispatch route/factory: `requiresWorkItem(spec) && no workItemId && no create-instruction ⇒ reject` (HTTP 422 + clear message). Maps to the orchestrator's attach/create choice.
- **Spine rename.** Stop overloading `parent_work_item_id` as the contract home; thread `contractId` as the dispatch spine (run row already has `contract_id`). `parent_work_item_id` keeps ONLY its dispatcher-lineage meaning. Drop `setAssignedAgentRunId` (the 1:1 link).
- **Dispatch input shape.** Routes + MCP tools accept one of `{ workItemId to attach · create-instruction (title/parent/...) · nothing }`.
- **014a server wiring (folded in).** `agent-verification.ts`: build the wider `EvaluationContext` (report + payload + externalHandle from the contract deliverable; `toolCalls` from the producing run's session checkpoint via the injected `loadSessionReplayCheckpoint`; `pendingAskCreated` from the DB), add the `hasGitDiff` executor, add the fail-closed branch keyed on `KINDS_REQUIRING_EVIDENCE`. Read tier/AC/expectedOutput from the contract (drop the `?? wi.*` fallbacks here).
- Tests + live-verify.

## Scope (out)
- Verification FLIPPING the contract instead of the WI, WI-advance-as-roll-up — **020**. (019 leaves the WI flip in place; it only changes what's created + what's verified against.)
- Prompt/tool rewrites that teach the orchestrator the new dispatch shape — **021**. (019 keeps the tools accepting the new input; the orchestrator-facing prose changes in 021. Risk: until 021, the orchestrator prompt still says "create a work item first" — acceptable because the create path still works, just no longer mandatory.)
- UI — **022**. Schema column drops — **023**.

## Decision 4 — WI-requirement policy (locked cells + leans)
| `expectedOutput.kind` | requires WI | basis |
|---|---|---|
| `answer` | no | locked |
| `payload` | no | locked |
| `prose` (store `contract`) | no | locked |
| `prose` (store `work_item_body`/`attachment`/`repo_file`/unset) | yes | locked |
| `action` | no | the act is the deliverable |
| `repo` | **yes (lean)** | open fork — persists outside the contract, like a doc on disk |
| `external` | **no (lean)** | open fork — the handle is the record |
| `binary` | **no (lean)** | open fork — attachment may live on the contract |
Open cells default to the lean; flip is a one-line edit in `work-item-policy.ts`.

## Current-State Evidence
- `agent-run-factory.ts:279–297` (WI hard-fail), `:340–341` (`parentWorkItemForRow`), `:346–359` (`insertAgentRunRow`), `:384–386` (`setAssignedAgentRunId`), `:388–398` (`resolveContractForDispatch` call), `:1180–1226` (`resolveContractForDispatch`, the `!workItemId → null` gate at 1187 + the WI-column-copy create path).
- `agent-work-item.ts:77–178` — `createAgentWorkItem` (WI-first creation; the contract columns it writes die in 023).
- `features/agent-runs/routes.ts` invoke/continue handlers — pass `workItemId`/`parentWorkItemId` straight through.
- `mcp/src/tools/{work-items,agent-runs}.ts` — `pc_create_agent_work_item` / `pc_invoke_agent`.
- `agent-verification.ts:104–203` + `createWorktreeExecutors` (the folded-in 014a wiring target).

## Target Shape (cartridge)
```
domain (work-item-policy.ts: expectedOutputRequiresWorkItem)
  -> app-service (contract authoring at dispatch: v2 expectedOutput + deriveAcceptanceCriteriaV2)
  -> agent-run-factory (always-create contract; contractId spine; reject guard; drop assigned_agent_run_id)
  -> route adapters (dispatch input: attach id | create-instruction | nothing; 422 on required-but-absent)
  -> agent-verification (folded 014a wiring: wider context + executors + fail-closed)
  -> tests (domain policy; factory always-creates + rejects; verification reads contract + fail-closed + tool_called from a checkpoint fixture)
  -> live-verify (contract-only research dispatch; repo dispatch rejected w/o a WI; action contract that skips its tool fails)
```

## Compatibility Contracts
- Existing WI-linked dispatches keep working (attach path). Only the *requirement* + the spine change.
- `parent_work_item_id` retains lineage meaning; nothing reads it as the contract home after this slice.
- The orchestrator prompt still references the old flow until 021 — the create path remains functional, so this is forward-compatible, not breaking.

## Migration / Rollback
- No schema change (uses existing `agent_contracts` + `agent_runs.contract_id`). 
- Rollback: restore the `!workItemId → null` gate + the `assigned_agent_run_id` write; contracts created WI-less become inert orphans (harmless).

## Tests
- Domain: `expectedOutputRequiresWorkItem` for every kind + prose store variants (DONE).
- Factory: a dispatch with no WI creates a contract + runs; a `repo`/`prose-to-WI` dispatch with no WI + no create-instruction is rejected (422); an `answer`/`payload`/`action`/`external` dispatch with no WI succeeds; `contract_id` threaded onto the run; no `assigned_agent_run_id` write.
- Verification (folded 014a): reads tier/AC/report from the contract; `tool_called` resolves from a real session-checkpoint fixture; an action contract whose tool was never called fails end-to-end; fail-closed escalates an evidence-requiring kind with empty AC.
- `pnpm -r typecheck` clean; full suite green.

## Live Verification
- Dogfood: dispatch a research pod with no work item → a contract row + completed run, NO orphan WI.
- Dispatch a code/`repo` pod with no work item → loud reject.
- Dispatch an action contract (must-call-tool) where the agent skips the tool → fails (not passes).

## Stop Conditions
- Do NOT make verification flip the contract instead of the WI (020).
- Do NOT rewrite the orchestrator/pod prompts (021) — only accept the new dispatch input.
- Do NOT drop the WI contract columns (023).

## Tracker Update
- Add `019` planned + build rows to `refactor-tracker.md`; human-review row flagging the dispatch-shape + fail-closed behavior change.
