# Contract-first switchover — code trace

> Drafted 2026-06-02 from a 4-layer read-only trace (dispatch, schema, verification, UI+prompts).
> Drives the inversion described in `agent-contracts-and-deliverables.md` Decision 1 + Decision 4.
> Status: trace map. No code changed yet.

## Headline

Slice 013 was **additive only**: it added the first-class `agent_contracts` table + `ContractService` and a dual-read shim in verification. **Nothing was inverted or deleted.** Today the **work item is still the spine** of every dispatch — the contract is a satellite minted *because* a WI exists. The switchover makes the **contract** the always-created spine and the WI an optional input/output link.

Three coupling spines to break:
1. **`workItemId` is mandatory to dispatch** and is threaded by-name end to end (route → factory → run row `parent_work_item_id` → contract → env → terminal).
2. **`contract.id == work_item.id`** for every backfilled row (migration `0038`), plus `agent_runs.contract_id = parent_work_item_id`. New runtime contracts already use fresh ULIDs, so code must stop assuming the equality.
3. **9 contract columns on `work_items`** are still actively read — primarily at dispatch (`agent-run-factory.ts`) and reject (`agent-verification-review.ts`), which have **no** contract-preference fallback at all.

Also confirmed: the **verification defect is NOT fixed** (action contracts still pass-by-default; `EvaluationContext` still has no tool-call stream; evaluator/derivation still on the v1 union). Slice 014 owns it whole.

---

## Layer 1 — Dispatch & creation

**The two doors:** `POST .../agents/:name/invoke` → `dispatchFreshAgent`; `POST .../agent-runs/:runId/continue` → `dispatchContinueAgent`. WI is created earlier via `POST .../work-items/create-agent-contract` → `createAgentWorkItem`. The orchestrator is taught to call create-WI first, then pass the id to `pc_invoke_agent`.

| Site | What it does | Class |
|---|---|---|
| `agent-work-item.ts` `createAgentWorkItem` (77–178) | Creates the WI with all contract columns, then mints a satellite contract | **INVERT** (contract becomes primary) + **DELETE** the WI contract-column writes (146–153) + `ephemeral` (45,137,152) |
| `agent-run-factory.ts` `resolveContractForDispatch` (1180–1226) | "no `workItemId` ⇒ no contract" gate (early return 1187) | **INVERT** — always create a contract; WI optional |
| `agent-run-factory.ts` `dispatchFreshAgent` WI block (279–297), `parentWorkItemForRow` (340–341), `insertAgentRunRow` (346–359) | Hard-rejects missing WI; overloads `parent_work_item_id` as the contract home | **INVERT** — thread `contractId` as spine; hard-fail becomes the Decision-4 loud reject |
| `dispatchContinueAgent` mirror (477–549) | same | **INVERT** |
| `setAssignedAgentRunId` calls (385–386, 537–538) | the 1:1 WI↔run link | **DELETE** |
| `features/agent-runs/routes.ts` invoke/continue handlers | pass `workItemId`/`parentWorkItemId` straight through | **INVERT** — accept {attach id · create-instruction · nothing} + enforce reject guard |
| `features/work-items/routes.ts` `create-agent-contract` (275–342) | HTTP wrapper for createAgentWorkItem | **INVERT** — repoint at a contract-create service |
| `mcp/src/tools/work-items.ts` `pc_create_agent_work_item` (65–119) | the literal WI-is-the-contract tool | **INVERT** |
| `mcp/src/tools/agent-runs.ts` `pc_invoke_agent`/`pc_continue_agent` | forward `workItemId` | **INVERT** |

---

## Layer 2 — Schema & persistence

**`agent_contracts`** (`schema-agent-system.ts:119-160`, migration `0038`) already carries the full spec: `workItemId` (nullable FK, 1:many), `agentRunId`, `attempt`, `issuedBy`, `podName`, `expectedOutput`, `acceptanceCriteria`, `verificationTier/Status/Notes`, `report`, `deliverable` (owned here), `worktreePath`, `status`, `version`. **KEEP — this is the target.**

**9 legacy contract columns on `work_items`** (`schema.ts:163-203`, migration `0016`) — all still read, all **DELETE** after switchover (one `DROP COLUMN ×9` + drop `work_items_agent_task_idx`; `assertSchemaIntact` auto-tracks from `schema.ts`):

`is_agent_task`, `ephemeral`, `acceptance_criteria`, `expected_output`, `verification_tier`, `verification_status`, `verification_notes`, `assigned_agent_run_id`, `worktree_path`.
(NOT contract baggage, **KEEP**: `is_workflow_root`, `areaId`, `callsign`, `position`, `version`, `history`.)

**The id-equality coupling to break:** backfill `c.id = w.id` (`0038:62`), `agent_runs.contract_id = parent_work_item_id` (`0038:94-100`), and `getBackfilledContractForWorkItem` = `getContract(workItemId)` (`contracts.ts:222`). → **DELETE** `getBackfilledContractForWorkItem`; new code must never assume the equality.

**Repos:** `repos/work-items.ts` — strip the 9 fields from `WorkItemRow`/`toDomain`/`CreateWorkItemInput`; **DELETE** `listEphemeralCompletedOlderThan` (608), `setAssignedAgentRunId` (681), `applyAgentVerification` (644) [moves to contracts repo, where `setContractVerification`/`setContractRun` already exist]. `ephemeral-work-item-sweep.ts` service dies whole.

**Domain types:** `work-item.ts` `WorkItem` — strip the 9 contract fields. `work-item-contract.ts` (v1 union) — **DELETE after switchover** (still consumed by `deriveAcceptanceCriteria` + `agent-work-item.ts` + the evaluator until they move to `contract.ts` v2).

---

## Layer 3 — Verification, deliverable capture & terminal

| Site | What it does | Class |
|---|---|---|
| `agent-verification.ts` input gate (104–111) | returns null unless `workItemId` + `wi.isAgentTask` | **INVERT** — gate on a contract |
| tier shim (119–120) `?? wi.verificationTier` | dual-read fallback | contract-read INVERT; `?? wi.*` **DELETE** |
| AC shim (173) `?? wi.acceptanceCriteria` | dual-read fallback | contract-read INVERT; `?? wi.*` **DELETE** |
| empty-AC pass-by-default (171–191) | `criteria.length===0 ⇒ passed` | **the unfixed defect** — must fail-closed for action/side-effect |
| `EvaluationContext` build (193–203) | sources `wi.body`/`wi.fields`/WI attachments/children; **no tool-call stream** | **INVERT** + add tool-call stream |
| all `applyAgentVerification` flips (127,153,175,210,232) | flip the **WI** status | **INVERT** → `ContractService.setVerification`; WI flip becomes a roll-up |
| `resolveContractFor` (312–322) | finds contract *via the WI* | **INVERT/DELETE** — run already carries `contractId` |
| `agent-run-terminal-effects.ts` `captureDeliverable` `wi.body` fallback (184–188) + `getWorkItem` dep (73–75) | borrows WI body when result empty | **DELETE** (design kills this) |
| `captureDeliverable` `setDeliverable` write (190–199) | writes onto the contract, hard-coded `kind:'answer'` | **KEEP** dir; capture the *submitted* deliverable (014) |
| `finishTerminalEffects` verification keying (217–233) | only runs verification when `workItemId` exists, keyed by WI | **INVERT** — key on contract |
| `agent-verification-review.ts` approve/reject (69–190) | flips WI; reject reads `wi.assignedAgentRunId` | **INVERT** — approve/reject the contract; continuation resolves run from `contract.agentRunId` |
| `loadVerificationCandidate` (194–212) | guards `wi.isAgentTask` + `wi.verificationStatus==='pending'` | **INVERT** — guard `contract.status==='verifying'` |
| `auto-advance-done.ts` `autoAdvanceToDoneStage` | moves WI to done stage | **KEEP** logic; re-trigger from contract-accept roll-up |
| `ac-evaluator.ts` / `ac-derivation.ts` | switch the v1 spec/predicate union; echo-poisonable `body_contains`; no new predicates | **INVERT** — move to v2 union, add `report_contains`/`tool_called`/`pending_ask_created`/etc., echo guardrail |
| `agent-event-header.ts` verification block + prose (31–39, 210–219) | keys envelope on `workItemId`; "read the work item body / pc_resolve_work_item" | **INVERT** — key on contract |
| `agent-run-writer.ts` | run-row terminal write | **KEEP** (out of scope) |

---

## Layer 4 — UI & orchestrator/pod prompts

### UI (`apps/web`)
| Site | Class |
|---|---|
| `features/contracts/work-log.ts` (helpers, already v2 7-kind) | **KEEP** |
| `components/work-items/WorkLogSection.tsx` (contract timeline in WI inspector) | **KEEP** — the surviving contract view |
| `features/contracts/client.ts` `getContract` | **KEEP**; `getWorkItemContracts` **INVERT** — add project/session-scoped, WI-optional list |
| `hooks/use-work-item-contracts.ts` (hard `c.workItemId===` filter) | **INVERT** — add a project-scoped sibling hook |
| `store/work-items-view.ts` `showAgentContracts` slice | **DELETE** |
| `KanbanBoard.tsx` + `WorkItemsTable.tsx` agent-task filters + `hiddenAgentCount` | **DELETE** the agent-task branch |
| `WorkItemsToolbar.tsx` "Agent contracts" toggle UI | **DELETE** |
| `features/work-items/types.ts` `isAgentTask` field | **DELETE** once orphaned |

### Prompts & tool text (the orchestrator-facing teaching of the old model)
- `tool-registry.ts:92` — **"The work item IS the contract … is_agent_task=true … ephemeral: true"** → rewrite (catalog derives from here, don't hand-edit catalog).
- `tool-registry.ts:1273` (`pc_invoke_agent`) — "call pc_create_agent_work_item first … the agent knows its task via the work item." → rewrite.
- `pc_continue_agent` (1305,1318-1320), `pc_resolve_work_item` (159), `pc_get_work_item` agent-contract carve-out (769) → rewrite to contract.
- `orchestrator-pod-content.ts` — dispatch recipe (72–89), v1 expected_output kinds (79–87), verify block (173–189), hidden-WI carve-out (220–222), tool list (301). → rewrite to contract-first + Decision-4 rule + reject guard.
- `pod-materializer.ts` `renderAssignment` (300–331) — **"You are assigned to work item … persist the deliverable on the work item."** → assignment is a CONTRACT; submit the deliverable.
- `dag-run-service.ts` initialInput (466–472) — "your assignment is work item … update the work item." → route through the contract (workflow WIs genuinely exist, but speak contract).
- `tool-catalog.ts:118-124` `REQUIRED_AGENT_TOOLS` comment + forced set (`pc_get_work_item`/`pc_update_work_item`/`pc_attach_to_work_item`) → contract-fetch + `pc_submit_deliverable` (014).
- `stock-pod-seed.ts` worker prompts ("pinned work item") + caisson "## Work-item-as-contract" explainer (699–708) → "your contract." **(downstream — must follow tool/route/domain changes or ship silent breakage.)**
- `workflow-builder-pod-content.ts` (113,189) → v2 union + new assignment text.
- `pod-defaults.ts` `POD_DEFAULTS` — imports v1 union → **INVERT** to v2 `ExpectedOutput`; add Decision-4 `store`/WI-required per default.

---

## Recommended switchover order

1. **Domain v2 cutover** — move evaluator/derivation/pod-defaults off `work-item-contract.ts` (v1) onto `contract.ts` (v2); land the new predicates + fail-closed. (This is largely slice 014; it unblocks everything else.)
2. **Dispatch inversion** — `resolveContractForDispatch` always creates a contract; `workItemId` optional; Decision-4 loud-reject guard; stop overloading `parent_work_item_id`; drop `setAssignedAgentRunId`.
3. **Verification/terminal inversion** — read + flip the contract; drop the `wi.*` fallbacks and the `wi.body` deliverable fallback; WI status flip + auto-advance become a roll-up fired only when an output-linked contract is accepted.
4. **Tool + prompt rewrite** — `tool-registry.ts` first (catalog + pods derive from it), then `pod-materializer`/`dag-run`/orchestrator prompt/stock pods.
5. **UI** — delete the toggle + hidden-rows machinery; keep the work-log; add the WI-optional contract list/hook.
6. **Schema cleanup (last)** — drop the 9 `work_items` columns + index + `getBackfilledContractForWorkItem` once nothing reads them (design Slice 015).

## Test impact (active dirs only)
Pinning the old behavior: `apps/server/test/contracts-slice-013.test.ts` (WI-flip + `wi.body` fallback), `apps/server/test/no-bypass-gate.test.ts`, `packages/db/test/contracts.test.ts`, `packages/app-services/test/contract-service.test.ts`, `packages/contracts/test/{contracts,work-items,areas}.test.ts`, `packages/app-services/test/{work-item-gateway,work-item-adapters,project-changed-live-event}.test.ts`, `packages/mcp/test/{typed-client.test.ts,__golden__.json}`, `apps/web/test/{work-log,work-item-live-events}.test.ts`.
(Many old unit specs — `agent-work-item`, `agent-verification*`, `ac-*`, `pod-*`, `dag-run-service` — live only under `archive/tests/` and don't gate CI; revive as needed.)
