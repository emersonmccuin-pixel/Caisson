# Contract-first switchover — build plan

> Drafted 2026-06-02. Sequences the inversion described in `refactor plan docs/agent-contracts-and-deliverables.md` (Decision 1 + Decision 4).
> Backed by the per-site trace `refactor plan docs/contract-first-switchover-trace.md` — that doc holds the file:line kill/invert/keep detail; this doc holds the slice order + per-slice scope.
> Status: planned. Do not build until asked. Each slice gets its own full cartridge doc the session before it's built.

## What this delivers

Today the **work item is the spine** of every dispatch and the contract (built in 013) is a passenger. This plan flips it: the **contract is always created**, the **work item is an optional input/output link** the orchestrator attaches or creates per Decision 4, and all the legacy "WI-is-the-contract" machinery is deleted.

## Safety net

Slice 013's **dual-read shim** (verification reads the contract first, falls back to the WI columns) is what makes this incremental. Every slice below keeps the system green: we move authority onto the contract one layer at a time, and only drop the legacy columns in the **last** slice, after nothing reads them.

## Dependency order

```
014 (reliable deliverables: v2 domain + submission gating + verification-defect fix)   ← foundation, already designed
        │
        ▼
019 Dispatch inversion (contract-first creation; Decision-4 WI resolution; loud reject)
        │
        ▼
020 Verification & terminal go contract-authoritative (flip the contract; WI advance = roll-up)
        │
        ├──────────────┐
        ▼              ▼
021 Prompts & tools   022 UI (delete toggle/hidden-rows; keep work-log; WI-optional list)
        │              │
        └──────┬───────┘
               ▼
023 Schema cleanup (drop the 9 work_items columns + dead repo fns + v1 union file)   ← last
```

021 and 022 can run in parallel once 020 lands. 023 is strictly last.

## One thing to resolve inside 019

Decision 4's loud-reject guard needs a fixed **"does this output kind require a work-item home?"** table. The known cells are locked; three are open forks (`repo`, `external`, attachment-on-contract). 019 ships the table with the known cells + a conservative default for the open ones (lean: `repo` requires a WI, `external` does not, attachments may live on a contract), and the forks resolve to firm cells as the first real cases hit them. The guard reads the table — changing a cell later is a one-line policy edit, not a code change.

---

## Slice 014 — Reliable deliverables (FOUNDATION, already designed)

Already scoped in the design doc's slice breakdown. Recap of why it's first:
- Moves the acceptance-criteria **evaluator + derivation off the v1 union** (`work-item-contract.ts`) onto the **v2 union** (`contract.ts`) — the 7 mechanisms (answer/prose/payload/repo/external/binary/action).
- Adds the new predicates (`report_contains`, `tool_called`, `pending_ask_created`, `schema_valid`, `git_diff_nonempty`, `external_handle_present`) + the **tool-call stream** in `EvaluationContext`.
- **Fail-closed auto-tier** (an action/side-effect contract with no evidence predicate escalates to review instead of passing open) — fixes the confirmed-still-open verification defect.
- `pc_submit_deliverable` + completion gated on an accepted submission (replaces the `end_turn`-then-inspect trust model).

Everything below assumes the v2 union is the live spec and submission is the deliverable source. **Write the 014 cartridge doc before building.**

---

## Slice 019 — Dispatch inversion (contract-first)

**Goal:** a dispatch creates a contract, never a work item. The WI becomes an optional link the caller supplies or asks to create.

**Changes (INVERT):**
- `agent-run-factory.ts` `resolveContractForDispatch` — remove the "no `workItemId` ⇒ no contract" early return; **always** create a contract at dispatch. `workItemId` becomes an optional link, not the trigger.
- `dispatchFreshAgent` / `dispatchContinueAgent` — stop overloading `parent_work_item_id` as the contract home; thread `contractId` as the spine. The current hard-fail-on-missing-WI becomes the **Decision-4 loud reject**, keyed on the output-kind WI-requirement table.
- `features/agent-runs/routes.ts` invoke/continue handlers — accept the new dispatch input: exactly one of `{ workItemId to attach · create-instruction (title/parent) · nothing }`; enforce the reject guard.
- `features/work-items/routes.ts` `create-agent-contract` route + `mcp` tools `pc_create_agent_work_item` / `pc_invoke_agent` — repoint at a contract-create path; WI association is the optional attach/create step.

**Deletes:**
- The WI contract-column writes in `agent-work-item.ts` (`isAgentTask`, `expectedOutput`, `acceptanceCriteria`, `verificationTier`, `assignedAgentRunId`) + the `ephemeral` field.
- `setAssignedAgentRunId` calls (the 1:1 WI↔run link).
- Any code assuming `contract.id == work_item.id` (`getBackfilledContractForWorkItem`).

**Depends on:** 014 (v2 spec authored on the contract).
**Verify:** unit — a dispatch with no WI creates a contract and runs; a `repo`-kind dispatch with no WI is rejected loudly; an `answer`-kind dispatch with no WI succeeds. Live — dispatch a research pod with no work item, confirm a contract row + a completed run, no orphan WI created.
**Risk:** the spine rename (`parent_work_item_id` → `contractId`) touches run-row insert + env + terminal threading; do it as one mechanical pass and lean on the existing dispatch tests.
**Stop:** don't touch verification flip logic (020) or prompts (021) here.

---

## Slice 020 — Verification & terminal go contract-authoritative

**Goal:** the agent's terminal transition reads and flips the **contract**; the work item moving to "done" becomes a side effect that only fires when a WI is linked.

**Changes (INVERT):**
- `agent-verification.ts` — gate on the contract (the run carries `contractId`), not on `workItemId` + `wi.isAgentTask`. Read tier + AC from the contract only.
- All `applyAgentVerification` WI flips → `ContractService.setVerification` (contract → accepted/rejected/verifying). The WI status flip + `autoAdvanceToDoneStage` become a **roll-up** fired only when an output-linked contract is accepted.
- `agent-run-terminal-effects.ts` `finishTerminalEffects` — key verification on the contract, not the WI.
- `agent-verification-review.ts` approve/reject — act on the contract; the reject continuation resolves the producer run from `contract.agentRunId`, not `wi.assignedAgentRunId`.
- `agent-event-header.ts` — completion envelope + prose key on the contract id (carry the linked WI id only when present).

**Deletes:**
- The `?? wi.verificationTier` and `?? wi.acceptanceCriteria` fallbacks (dual-read shim retired).
- `captureDeliverable`'s `wi.body` fallback + its `getWorkItem` dep (deliverable comes from the 014 submission).
- `resolveContractFor`'s WI→contract reverse lookup.

**Depends on:** 014 (predicate engine + submission) + 019 (contract is the spine).
**Verify:** unit — verification passes/fails reading only the contract; a contract with no WI verifies and has no WI side effects; an output-linked contract acceptance advances its WI to done. Live — run a contract-only dispatch and a WI-linked dispatch; confirm the contract flips in both, the WI advances only in the second.
**Risk:** the roll-up trigger is the subtle part — make WI advance fire exactly once, on contract-accept, only for output-linked contracts.

---

## Slice 021 — Prompts & tools rewrite

**Goal:** stop teaching the orchestrator and agents the dead model. (Per project memory: pod prompts are downstream of tool/route/domain changes — these MUST follow 019/020 or they ship silent breakage.)

**Changes (INVERT):**
- `tool-registry.ts` first (catalog + pod required-tools derive from it — never hand-edit the catalog): rewrite `pc_create_agent_work_item` ("the work item IS the contract … is_agent_task … ephemeral"), `pc_invoke_agent` ("create a work item first"), `pc_continue_agent`, `pc_resolve_work_item`, `pc_get_work_item`'s agent-contract carve-out. Tools speak contracts; WI is the optional link.
- `runtime/pod-materializer.ts` `renderAssignment` — "you are assigned to work item X / persist on the work item" → "your contract / submit your deliverable."
- `dag-run-service.ts` child-node initialInput — route through the contract (workflow WIs genuinely exist, but speak contract).
- `orchestrator-pod-content.ts` — dispatch recipe, the v1 expected_output kinds list (→ v2), the verify block, the hidden-WI carve-out, tool list. Add the Decision-4 attach/create rule + the loud-reject expectation.
- `tool-catalog.ts` `REQUIRED_AGENT_TOOLS` — contract-fetch + `pc_submit_deliverable` instead of the forced WI tools.
- `stock-pod-seed.ts` worker prompts ("pinned work item" → "your contract") + the caisson "## Work-item-as-contract" explainer.
- `workflow-builder-pod-content.ts` + `pod-defaults.ts` — v2 union; each pod default declares whether its output needs a WI home (Decision-4 table).

**Depends on:** 019 + 020 (tools must describe the new reality).
**Verify:** unit — golden/registry tests for the rewritten tool descriptions; pod-default round-trips on the v2 union. Live — dogfood a full orchestrator session: it dispatches contract-first, attaches/creates a WI only when the output needs one, and the agent boot text references the contract.
**Risk:** breadth — grep every `*-pod-content.ts` referencing contracts before declaring done.

---

## Slice 022 — UI

**Goal:** drop the "agent tasks are hidden work items" machinery; keep the contract views.

**Deletes:**
- `store/work-items-view.ts` `showAgentContracts` slice.
- `KanbanBoard.tsx` + `WorkItemsTable.tsx` agent-task filters + `hiddenAgentCount`.
- `WorkItemsToolbar.tsx` "Agent contracts" toggle UI.
- `features/work-items/types.ts` `isAgentTask` field (once orphaned).

**Changes (INVERT/KEEP):**
- `features/contracts/work-log.ts` + `WorkLogSection.tsx` — **KEEP** (already v2; the surviving contract view).
- `features/contracts/client.ts` + `use-work-item-contracts.ts` — add a project/session-scoped, **WI-optional** contract list + hook (so contract-only dispatches are visible), alongside the per-WI "output landed here" view.

**Depends on:** 019 (contract-only dispatches exist) + a contract-list endpoint.
**Verify:** live — board no longer shows agent tasks or a toggle; the work-log still renders a WI's contracts; a contract-only dispatch appears in the project-scoped contract view.
**Risk:** low; mostly deletion.

---

## Slice 023 — Schema cleanup (LAST)

**Goal:** remove the dead columns once nothing reads them.

**Deletes:**
- `work_items` columns: `is_agent_task`, `ephemeral`, `acceptance_criteria`, `expected_output`, `verification_tier`, `verification_status`, `verification_notes`, `assigned_agent_run_id`, `worktree_path` + the `work_items_agent_task_idx` index (new `DROP COLUMN ×9` migration; `assertSchemaIntact` auto-tracks from `schema.ts`).
- `repos/work-items.ts` — strip the 9 fields from `WorkItemRow`/`toDomain`/`CreateWorkItemInput`; delete `listEphemeralCompletedOlderThan`, `setAssignedAgentRunId`, `applyAgentVerification`; delete `ephemeral-work-item-sweep.ts`.
- `packages/domain/src/work-item-contract.ts` (v1 union) + the `WorkItem` contract fields.

**Depends on:** 014 + 019 + 020 + 021 (every reader gone).
**Verify:** `pnpm typecheck` clean (no references to the dropped fields); fresh-DB boot applies the migration; full suite green. Live — full dogfood session end to end.
**Risk:** the migration is destructive — confirm via grep + typecheck that zero readers remain before dropping. Keep the migration reversible-by-restore (back up the DB before running on the dogfood data).

---

## Tracker update (when these get built)
- Add slice docs `019`–`023` rows to `refactor-tracker.md` as planned.
- Each slice = a plan row + a build row + (where it changes behavior) a human-review row in `refactor-session-tracker.md`.
- Live-verify 019, 020, 021 on the dogfood stack — these change dispatch + verification behavior the unit tests can't fully prove.
