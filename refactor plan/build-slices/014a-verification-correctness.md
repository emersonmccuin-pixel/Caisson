# Slice 014a — Verification correctness (v2 engine + tool-call stream + fail-closed)

> Status: building. Split from the original slice 014; 014b (submission-gated completion + `pc_submit_deliverable`) follows.
>
> **Progress (2026-06-02):**
> - DONE — domain engine. `ac-evaluator.ts` widened to the v2 superset + 6 new predicates (`report_contains`, `tool_called`, `pending_ask_created`, `schema_valid`, `external_handle_present`, `git_diff_nonempty`) + a zero-dep JsonSchema validator; `EvaluationContext` gains `report`/`toolCalls`/`pendingAskCreated`/`payload`/`externalHandle` (optional, defaulted). `ac-derivation.ts` gains `deriveAcceptanceCriteriaV2` (v1 left intact for the dispatch path until 019) + `KINDS_REQUIRING_EVIDENCE` (`action`/`external`/`repo`). Exported from `@pc/domain`. Verified: full `pnpm -r typecheck` = 0 errors; new `packages/domain/test/ac-v2.test.ts` = 14/14 pass incl. the action-echo proof case.
> - TODO — server wiring. `agent-verification.ts`: build the wider context (report from the contract, `toolCalls` from the run's session checkpoint via `loadSessionReplayCheckpoint`, `pendingAskCreated` from the DB, `payload`/`externalHandle` from the deliverable), add the `hasGitDiff` executor, add the fail-closed branch keyed on `KINDS_REQUIRING_EVIDENCE`.
> - SEQUENCING NUANCE — the server fail-closed branch + the v2 predicates only fire once contracts carry **v2** `expectedOutput`/AC, which dispatch authors in **019**. So the server wiring is unit-testable now (v2 fixture) but stays inert in production until 019 flips dispatch. Build it complete + fixture-tested here; live-verify after 019.
> - DEFERRED within 014a — the echo-poisoning guard on `body_contains`/`report_contains`. It's defense-in-depth, NOT the load-bearing fix (fail-closed + `tool_called`/`pending_ask_created` already close the proof case), and a naive guard would falsely reject legitimate prose-section checks (section names are prompt-derived). Implement it precisely (reject only matches that vanish when the prompt text is removed) as a tracked follow-up.
> Design: `refactor plan docs/agent-contracts-and-deliverables.md` (§"verification defect", §"Reliability"). Trace: `refactor plan docs/contract-first-switchover-trace.md`. Sequence: `build-slices/contract-first-build-plan.md`.

## Roadmap Alignment
- Foundation for the contract-first switchover (slices 019–023). Must land before dispatch inversion so the contract carries a real, verifiable spec.
- Depends on 013 (contract entity + service, done). Pairs with 014b.
- This slice is the **verification-defect fix**: it makes auto-tier fail-closed and gives it the tool-call evidence it structurally lacked. It does NOT change the completion condition (still `end_turn`-then-verify) — that's 014b.

## Concept
The acceptance-criteria engine runs on the **v1** `ExpectedOutput`/predicate union (`work-item-contract.ts`) and proved unsound: an `action`/`side-effect` contract with no bash check derives to `[]`, and empty criteria **passes by default** — so "your first action MUST be `pc_ask_user`" passed while the agent merely echoed the instruction. Root causes (confirmed still live): (1) `EvaluationContext` has no tool-call stream, so no predicate can assert a tool was called; (2) `body_contains` is echo-poisonable; (3) auto-tier passes open on empty AC.

This slice moves the engine to the **v2** union (`contract.ts` — 7 mechanisms + extended predicates), feeds it the run's **tool-call stream**, and flips auto-tier to **fail-closed** for action/side-effect contracts with no evidence predicate.

## Scope (in)
- **Engine v2 cutover.** `ac-evaluator.ts` + `ac-derivation.ts` import the v2 union from `contract.ts` (not `work-item-contract.ts`). Handle the v2 `ExpectedOutput` kinds (answer/prose/payload/repo/external/binary/action) and the v2 predicate set.
- **New predicates** in the evaluator: `report_contains` (searches the contract report, not the WI body), `tool_called` (name + min_count, reads the tool-call stream), `pending_ask_created` (durable side-effect of `pc_ask_user`), `schema_valid` (payload vs JsonSchema), `git_diff_nonempty`, `external_handle_present`.
- **`EvaluationContext` gains** `report: string` and `toolCalls: ReadonlyArray<{ name: string }>` (+ count). Keep `body`/`fields`/`attachments`/`childWorkItems` for the linked-WI cases.
- **Tool-call executor.** A server-side `PredicateExecutors` addition that loads the producing run's session checkpoint via the injected `loadSessionReplayCheckpoint` (the same byte-identical replay the transcript repository uses) and returns the tool_use names. No new read logic — reuse the replay.
- **Fail-closed auto-tier.** In `agent-verification.ts`: an `action`/`external`/`repo` contract (side-effect kinds) whose derived AC carries **no evidence predicate** escalates to `orchestrator-review` instead of auto-passing. Empty AC on a non-side-effect (answer/prose/payload) still trusts end-of-turn (unchanged).
- **Echo-poisoning guard.** `body_contains`/`report_contains` fail if the needle appears verbatim in the contract's `expectedOutput`/AC text (can't satisfy a check by parroting the prompt).
- **Derivation v2.** `deriveAcceptanceCriteria` maps each v2 kind to its evidence predicates (action → `tool_called`/`pending_ask_created`; repo → `git_diff_nonempty` + checks; payload → `schema_valid`; prose/answer → `report_contains`/min-chars; etc.).
- Tests across domain + server.

## Scope (out)
- `pc_submit_deliverable` + completion gated on accepted submission — **014b**.
- Dispatch inversion / contract-first creation — **019**.
- Removing the v1 `work-item-contract.ts` file — happens once dispatch + derivation no longer reference it (023). This slice leaves the v1 union in place but stops the *evaluator* from depending on it.
- Removing WI columns — **023**.

## Current-State Evidence
- `packages/domain/src/ac-evaluator.ts` — v1 `EvaluationContext` (body/fields/attachments/childWorkItems, NO tool stream); switch over 7 v1 predicate kinds only; `evalBodyContains` echo-poisonable (corpus = body+attachments).
- `packages/domain/src/ac-derivation.ts` — derives from v1 `ExpectedOutput` (text/files/structured/side-effect/mixed); `side-effect` with no `verify_via_bash` → `[]` (the silent-pass path).
- `packages/domain/src/contract.ts` — the v2 union + extended predicate kinds already DEFINED (013); never wired into the evaluator.
- `apps/server/src/services/agent-verification.ts:171-191` — empty-AC ⇒ `passed` (the pass-by-default defect); `EvaluationContext` built from `wi.*` at :193-203; `createWorktreeExecutors` at :254-306 (where the tool-call executor joins).
- `packages/app-services/src/conversations/transcript-repository.ts` + the injected `loadSessionReplayCheckpoint` — the readable tool-call source.
- Tools `pc_ask_user` / `pc_answer_pending` exist (pending-ask durable side-effect source for `pending_ask_created`).

## Target Shape (cartridge)
```
domain (contract.ts v2 union — already exists)
  -> ac-evaluator.ts + ac-derivation.ts (import v2; new predicates; EvaluationContext gains report + toolCalls)
  -> app-service executor (agent-verification.ts: tool-call executor via loadSessionReplayCheckpoint; fail-closed auto-tier; echo guard)
  -> tests (domain unit: every v2 predicate + derivation + echo guard; server: fail-closed escalation + tool_called from a real transcript fixture)
```

## Files
- `packages/domain/src/ac-evaluator.ts`, `ac-derivation.ts` (v2 cutover + new predicates + context fields).
- `packages/domain/src/contract.ts` (no change expected; it's the source of truth).
- `packages/domain/src/index.ts` (export the v2-bound evaluator/derivation + the widened `EvaluationContext`/`PredicateExecutors`).
- `apps/server/src/services/agent-verification.ts` (build the wider context: `report` from the contract, `toolCalls` from the run checkpoint; add the tool-call executor; fail-closed branch; echo guard wiring).
- Tests: `packages/domain/test/ac-evaluator.test.ts`, `ac-derivation.test.ts` (revive from `archive/tests` + extend); `apps/server/test/agent-verification.test.ts` (revive + the action-echo repro from the design's proof case).

## Compatibility Contracts
- Verification still **flips the work item** this slice (the contract-authoritative flip is 020). 014a only changes *what is checked and how*, not *what gets flipped*.
- The dual-read shim (contract-then-WI for tier/AC) stays; 014a reads AC from whichever source 013 resolves.
- v1 `work-item-contract.ts` stays importable for the dispatch + WI paths that haven't inverted yet; only the evaluator/derivation stop importing it.
- Auto-tier behavior change is intentional and **not** byte-identical: side-effect contracts that used to pass-open now escalate. This is the fix, not a regression — call it out in the human-review row.

## Migration / Rollback
- No DB migration (pure logic + a read-only executor). 
- Rollback: revert the evaluator/derivation to the v1 import + drop the fail-closed branch; the contract rows are unaffected.

## Tests
- Domain: each v2 predicate (incl. `tool_called` with a stub stream, `report_contains`, `schema_valid`, `git_diff_nonempty`, `external_handle_present`, `pending_ask_created`); derivation for every v2 kind; echo-poisoning guard rejects a parroted needle; empty-AC on answer/prose still passes, on action/external/repo escalates.
- Server: the design's proof case — a contract requiring `pc_ask_user` where the agent echoed the instruction and never called the tool → must NOT pass (escalates/fails). `tool_called` resolves true from a real session-checkpoint fixture that contains the tool_use.
- Full suite green; `pnpm typecheck` clean.

## Stop Conditions
- Do NOT add `pc_submit_deliverable` or change the completion condition (014b).
- Do NOT make verification flip the contract instead of the WI (020).
- Do NOT touch dispatch creation (019) or delete the v1 union file (023).
- Keep the linked-WI evaluation paths working — this is additive on the spec side, not a WI-removal.

## Tracker Update
- Add `014a` planned + build rows to `refactor-tracker.md`; a human-review row in `refactor-session-tracker.md` flagging the intentional fail-closed behavior change.
