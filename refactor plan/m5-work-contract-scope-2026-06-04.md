# M5 — FD-5: the Work Contract is the complete job spec (scope) — 2026-06-04

Sequencing row M5. Prereq for M6 (step-model v3) and FD-20 (Patterns). Absorbs two ledger
"ready now" items: **wi.body re-scope** (row 11) and **sync-invoke DELETE** (ledger §dead row,
`PcInvokeAgentResultSync`).

## Trace (where every FD-5 fact lives today)

**`expected_output` — already half-migrated.** The contract column EXISTS
(`agent_contracts.expected_output`, schema-agent-system.ts:138) and is written at every dispatch
(`resolveContractForDispatch`, agent-run-factory.ts:1034–1075). The pod column
(`agents.expected_output`, schema.ts:621) survives only as a **default** in an explicit
precedence chain (agent-work-item.ts:95–126):
dispatch-supplied → pod row → stock default (`pod-defaults.ts`) → hard fail.

**`output_destination` — never migrated.** Pod-only (`agents.output_destination`,
schema.ts:602). NO contract column. See refute 1.

**The deliverable result — already on the contract.** `setContractDeliverable`
(repos/contracts.ts:174–199) persists the typed payload + report on the contract row at
`pc_submit_deliverable`. The ONLY result-into-body write is the `store: 'work_item_body'`
branch of `applyDeliverableStore` (apply-deliverable-store.ts:87–101, via the M2 gateway).

**`$root.output`** (dag-run-service.ts:172–218): `$root.output` → run-root card `body`;
`$root.output.<field>` → card `fields`. `$nodeId.output` → that node's **contract deliverable**
via `contractDeliverableText` (packages/contracts/src/contracts.ts:141–149). Asymmetric by
design — the root card has no contract. The workflow-builder pod prompt documents `$root.output`
as **"the TRIGGERING card's body / brief"** (workflow-builder-pod-content.ts:210, 265).

**Agent-side readability (FD-5 addendum gaps, confirmed):** no `pc_get_contract` in the
registry; acceptance criteria never surfaced to the agent (only the expected-output spec is
inlined once by the materializer's "## Your assignment"); no `pc_list_attachments` /
`pc_get_attachment` (the dispatch prompt tells agents to use attachments they cannot fetch —
pod-materializer.ts:320).

**sync-invoke — pure vapor.** `PcInvokeAgentResultSync` + `PcInvokeAgentInput.wait`
(agent-comms.ts:142–175) typed but never wired: the MCP handler drops `wait`, the route
hardcodes `mode:'async'` (agent-runs/routes.ts:489), agent-audit's `'sync'` branch
(agent-audit.ts:54–56) is unreachable.

## Refute corrections (vs the FD-5 text + ledger wording)

1. **"`output_destination` moves to the contract" → it is a DEAD KNOB.** Grep-verified: every
   reference is storage / edit-UI / seed / audit plumbing (pod-routes, SettingsTab,
   CreatePodModal, HistoryTab filter, stock seeds, drift lists). **Zero runtime consumers** —
   nothing routes a deliverable by it; results reach the user via terminal envelope →
   orchestrator relay, and prose placement is `expectedOutput.store`. Same class as the FD-15
   dead concurrency knob. Migrating it would carry rot onto the contract. → **DELETE, not move**
   (FD-5 amendment, Emerson confirmed 2026-06-04).
2. **"the body↔`$root.output` coupling is load-bearing for deliverables" → load-bearing for the
   BRIEF, not the result.** Live DB: 7 active defs use `$root.output` (as workflow input);
   **ZERO defs use `store: work_item_body`**; 2 contracts ever carried it (slice-014c era).
   `$root.output`'s documented semantic is already "the card's brief" — after the split it keeps
   reading `body` and its meaning becomes exactly what the docs claim. The round-trip guard pins
   this (slice A), it does not protect a result path.
3. **"`expected_output` comes off the pod" → it already is off the pod as authority.** The pod
   column is a *default*; 13 pod rows (incl. custom pods `jira-story`, `zephyr-create`,
   `pr-opener`, `ahead-qa`, `coder`, `qa-tester`) carry defaults that pod-templated dispatch
   relies on. Deleting outright = every custom-pod dispatch must inline a full spec or hard-fail.
   → **KEEP as documented default, dispatch always wins** (FD-5 wording amendment, Emerson
   confirmed 2026-06-04). The "silently overridden" risk FD-5 feared is already structurally
   gone (explicit precedence, contract row is the authority for the run).

## Design

- **Body = brief-only law.** ☠ `store: 'work_item_body'` whole: the `ExpectedOutput` prose
  `store` union loses the variant (domain contract.ts), `deriveAcceptanceCriteriaV2` loses the
  body-targeting branch (`useBody` for that store), `applyDeliverableStore` loses the branch,
  orchestrator + workflow-builder prompts lose the mention, slice-014c tests re-point. Prose
  deliverables: `store` defaults to `contract`; `attachment` / `repo_file` survive.
- **`$root.output` keeps reading `body`** — now guaranteed to be the brief. Rename to
  `$root.brief` = M6 vocab cleanup (breadcrumb, not here).
- **`output_destination` dies whole:** archive-rename migration (0041 precedent), domain type +
  `AgentDef.pc.outputDestination` frontmatter parse, pod routes fields, web Settings/Create
  inputs, audit filter entry, seeds, drift lists, `pc_create_agent`/`pc_update_agent` tool args
  (golden regen). Banned-resurrection += names.
- **`pc_get_contract` (FD-5 addendum):** new worker-tier tool — a dispatched agent reads its OWN
  contract mid-run: expected output, **acceptance criteria**, status, linked work item. Resolved
  server-side from `PC_AGENT_RUN_ID` (same as `pc_submit_deliverable`). Materializer
  "## Your assignment" points at it instead of inlining once.
- **Attachment read tools (companion audit gap):** `pc_list_attachments` + `pc_get_attachment`
  (worker baseline) — closes "directed to use what it cannot access" 🔴.
- **sync-invoke DELETE:** ☠ `PcInvokeAgentResultSync`, `PcInvokeAgentInput.wait`, audit `'sync'`
  branch (`RecordInvokeInput.mode` narrows to `'async'` or drops). Banned-resurrection += names.
- **Findings logged (not built here):** contract `attempt` never incremented (M6 retry) ·
  `issuedBy` never populated · pod-create route `expectedOutput` stub unvalidated (slice C adds
  the missing shape assert) · review route drives reject-loop synchronously (known, M3a).

## Slices — ALL SHIPPED 2026-06-04

- **A ✅ (40b2edca) — the round-trip guard (test only, FIRST per ledger).** Pins: prose
  deliverable → contract row; `$root.output` resolves the root card's body; `$nodeId.output`
  resolves the child contract deliverable verbatim (body-independent); no-deliverable → empty
  ref. Written against CURRENT behavior incl. work_item_body store, then amended in B — the diff
  IS the proof the move was deliberate.
- **B ✅ (4e320847) — body = brief-only.** ☠ work_item_body store everywhere (both ProseStore
  unions, AC derivation, store executor + its gateway use, Decision-4 policy cell flipped:
  unset-store prose defaults to `contract` → no WI required) + prompts + guard-test amendment +
  banned `work_item_body`.
- **C ✅ (224c4031) — pod field cleanup.** ☠ `output_destination` whole (migration 0042 + domain
  type + `pc:` frontmatter block + routes + seeds + drift/reset lists + MCP args + web inputs +
  History filter/revert; historical audit rows keep rendering) · pod `expected_output` documented
  as default (schema comment carries the precedence chain). CORRECTION: the trace's "pod-create
  route has an unvalidated expectedOutput stub" was an explorer MISREAD — pod-routes has no
  expectedOutput handling at all; nothing to fix.
- **E ✅ (74365555) — sync-invoke DELETE.** `PcInvokeAgentResultSync` + `wait` + audit 'sync'
  branch; stale wait-semantics comments fixed; banned name. (Ledger row 10.)
- **D ✅ (a3d8fff8 + AC-mint fix) — the agent can read its job.** `pc_get_contract` +
  `pc_list_attachments` + `pc_get_attachment` (worker tier, 52→55, golden regen, REQUIRED set
  7-strong) + GET `/agent-runs/:runId/contract` (3 route tests) + materializer pointers.
  **Live-fire finding → fixed same day:** the dispatch door minted contracts with
  `acceptanceCriteria: null` (only `createAgentWorkItem` derived them; the verifier
  derived-on-null at terminal, so the agent's contract read showed null AC — defeating the
  addendum). `resolveContractForDispatch` now derives AC onto the row at mint when a spec
  exists. Verifier behavior unchanged.

## Verification — RESULTS (live, 2026-06-04, dev stack)

- Suites: db 41 · domain 20 · contracts 76 · mcp 75 · runtime 41 · server 266 · web 126;
  workspace typecheck green. Migration 0042 applied on live boot (column gone, API clean).
- **Live run 1** (researcher, no spec): `pc_get_contract` over the signed wire → delivered →
  completed ~15s. Exposed finding 1 (below).
- **Live run 2** (researcher, spec + linked WI + attachment): read contract → `pc_list_attachments`
  → `pc_get_attachment` → submitted the secret word (`tangerine-47`) + predicate kind →
  verification PASSED on real derived AC. All three tools proven in one run.
- **Live run 3** (post AC-mint fix): agent echoed its `acceptanceCriteria` VERBATIM
  (`[{"kind":"report_contains","pattern":"criteria-check"}]`) — the addendum's exact ask.
- **Live run 4**: `file-then-review` fire → write → review gate → approve → **completed**; diary:
  workflow_started → node_started → agent_dispatched → node_completed → review_requested →
  review_approved → workflow_completed.

## Findings (logged, not built here)

1. **Spec-less contracts from ad-hoc dispatch** (FD doc, M5 finding): `pc_invoke_agent` without
   `expected_output` mints a NULL-spec contract — `resolveContractForDispatch` consults neither
   the pod default nor the stock map (only `createAgentWorkItem` does). Wiring the fallback
   changes Decision-4 behavior (spec-less code-writer dispatch would start requiring a WI) →
   deliberate pass in M6/contract work, not a patch.
2. Contract `attempt` never incremented · `issuedBy` never populated → M6 (FD-9 retry/provenance).
3. mcp.md carried pre-FD-2 content (stdio child, heartbeat, P7-deleted draft tools) — swept here.

## Out of scope (breadcrumbs)

- `$root.output` → `$root.brief` rename + ref-grammar vocab sweep → M6.
- Contract `attempt` retry semantics + `issuedBy` provenance → M6 (FD-9 loop ceiling).
- Fence-relative dispatch payloads (shelved 2026-06-03) — revisit WITH the contract shape work
  here if Emerson re-opens it; not built in M5.
- Work Item vs Work Contract model write-up (decision backlog) — M5 narrows the gap but the
  prose doc rides the backlog item.
