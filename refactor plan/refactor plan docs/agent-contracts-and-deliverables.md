# Agent Contracts & Deliverables

> Status: design / reference. Drafted 2026-05-31.
> Supersedes the core premise of **Section 26 (work-item-as-contract)**: a contract is NOT a work item.
> Drives build slices **013** (first-class contract + work log) and **014** (reliable-deliverable taxonomy + submission-gated verification).

## The two problems

1. **Contracts are conflated with work items.** Section 26 bolted the contract onto `work_items` (`is_agent_task`, `expected_output`, `acceptance_criteria`, `verification_tier/status/notes`, `assigned_agent_run_id`, `ephemeral`, `worktree_path`). A work item is a human-tracked unit of work; a contract is a machine-checkable assignment with an output. Different lifecycles, forced into one table.
2. **Output is not reliable.** The agent learns its expected output from prose in the prompt and is trusted to free-form a deliverable; verification inspects the resulting artifact *after the fact*. For an action contract there is no artifact to inspect — so it silently passes. See "The verification defect" below.

Both are the same fix from two ends: a contract **is** the spec of expected output plus the lifecycle that makes the output happen and get checked.

## Decision 1 — contract is a first-class entity

New `agent_contracts` table. What moves onto it (off `work_items`):

- `id`, `agentRunId` (nullable until dispatched), `attempt` (retries live here, not new work items)
- `workItemId` — **optional** FK. A contract MAY roll up to a human work item; usually does (powers the work log), but doesn't have to. This kills the `ephemeral` hack.
- `issuedBy` — provenance (orchestrator session / workflow stage / parent run)
- `expectedOutput` (typed spec), `acceptanceCriteria` (derived), `verificationTier`
- `report: string` — free text to the orchestrator. Always present.
- `deliverable: Deliverable | null` — **owned here**, not borrowed from `wi.body`. Kills the Slice-009 "surface work-item deliverable when result empty" fallback.
- `verificationStatus`, `verificationNotes`, `status`

Smells this removes: the "See Agent Contracts" hidden-rows toggle (contracts stop being hidden work items), the `ephemeral` flag, the 1:1 `parentWorkItemId`/`assignedAgentRunId` link that can't model retries or multiple agents per work item, the empty-result `wi.body` fallback.

Relationship going forward: **work item = human-tracked unit; contract = machine assignment; link is optional and one-to-many** (many contracts : one work item). Section 37 (work-items redesign) gets simpler because work items stop carrying agent-execution baggage.

## Decision 2 — report vs deliverable

Every contract result has two halves:

- **report** — the free-text envelope to the orchestrator ("here's what I did"). Always present.
- **deliverable** — the typed, verified artifact. Its `kind` selects the capture + verify mechanism.

For a pure question-answer contract they coincide (the report *is* the deliverable). This dissolves "responding to the orchestrator" as a peer of "do code work": it's the degenerate `answer` case.

## Decision 3 — seven deliverable mechanisms

The ~20 semantic deliverable types (plan, PRD, research, ADR, code change, verdict, decomposition, email, diagram, …) collapse onto a small set of capture+verify mechanisms. Each semantic type is a **preset** that pins a mechanism + schema/predicates + storage target + verification tier.

| Mechanism | Semantic types | Captured as | Verified by | Lives in |
|---|---|---|---|---|
| **answer** | conversational reply | result text | soft / orchestrator-review | inline on contract |
| **prose** | plan, PRD, research, ADR, spec, runbook, summary, postmortem | markdown text | sections / min-chars / `body_contains` + review | attachment, WI body, or repo file |
| **payload** | extraction, classification, decision, verdict, decomposition, score | tool-call JSON | `schema_valid` + predicates | inline on contract |
| **repo** | code change (worktree or in-place) | git ref (branch/commit/diff) | `files_exist`, `git_diff_nonempty`, build/test/lint `bash_exit_zero` | git (pointer only) |
| **external** | email, calendar, chat, ticket, CRM, API call | returned handle/ID + idempotency key | `external_handle_present` + existence-check | external (handle) |
| **binary** | diagram, screenshot, export, dataset, build | BLOB | `attachments_present` + mime/size | attachment (DB) |
| **action** | required tool call (e.g. `pc_ask_user`) | the run's tool-call transcript | `tool_called` / `pending_ask_created` | — (the act is the deliverable) |

`action` is the seventh, added after the verification defect (below) proved the original six couldn't express "this tool must be called." Worktree-vs-in-place is an isolation axis (`worktreePath`), not a type. Composite ("write the doc AND open the PR") is **two contracts on one work item**, not one mixed contract — atomic verification, and the work-log view is what composes them.

## The schema (v2)

Lands in `packages/domain/src/contract.ts` (supersedes `work-item-contract.ts`).

```typescript
export const VERIFICATION_TIERS = ['auto', 'orchestrator-review', 'human-review'] as const;
export type VerificationTier = (typeof VERIFICATION_TIERS)[number];

export const VERIFICATION_STATUSES = ['pending', 'passed', 'failed'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const DELIVERABLE_KINDS = [
  'answer', 'prose', 'payload', 'repo', 'external', 'binary', 'action',
] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  [k: string]: unknown;
};

// ── ExpectedOutput: the spec the orchestrator authors ──
export type ExpectedOutput =
  | { kind: 'answer'; must_address?: string[]; min_chars?: number }
  | {
      kind: 'prose';
      doc_type?: ProseDocType;
      sections?: string[];
      min_chars?: number;
      store?: ProseStore;   // default: 'work_item_body' when a WI is linked, else 'attachment'
      path?: string;        // required when store === 'repo_file'
    }
  | { kind: 'payload'; schema: JsonSchema; semantic?: PayloadSemantic }
  | {
      kind: 'repo';
      isolation: 'worktree' | 'in_place';
      paths_touched?: string[];
      checks?: RepoCheck[];
      require_diff?: boolean;   // default true
    }
  | {
      kind: 'external';
      system: ExternalSystem;
      action: string;            // 'send', 'create_event', 'create_ticket', …
      confirm: 'always' | 'pre-authorized';
      idempotency_key: string;   // minted up-front by the issuer (phantom-UUID guard)
      verify_handle?: boolean;   // default true
    }
  | { kind: 'binary'; artifact_type?: BinaryArtifactType; mime?: string; min_size_bytes?: number }
  | { kind: 'action'; tool: string; min_count?: number; before_end_turn?: boolean };

export type ProseDocType =
  | 'plan' | 'prd' | 'research' | 'design' | 'adr'
  | 'spec' | 'runbook' | 'summary' | 'postmortem' | 'note';
export type ProseStore = 'contract' | 'attachment' | 'work_item_body' | 'repo_file';
export type PayloadSemantic =
  | 'extraction' | 'classification' | 'decision' | 'verdict' | 'decomposition' | 'score';
export type RepoCheck = { preset: 'build' | 'test' | 'lint' } | { command: string; cwd?: 'worktree' | 'project' };
export type BinaryArtifactType = 'diagram' | 'screenshot' | 'export' | 'dataset' | 'build';
export const EXTERNAL_SYSTEMS = ['email', 'calendar', 'chat', 'ticket', 'crm', 'api'] as const;
export type ExternalSystem = (typeof EXTERNAL_SYSTEMS)[number];

// ── Deliverable: the captured result. Mirror of ExpectedOutput by kind. ──
//    What the work-log view renders, one renderer per kind.
export type Deliverable =
  | { kind: 'answer'; text: string }
  | { kind: 'prose'; text?: string; attachmentId?: string; ref?: string }
  | { kind: 'payload'; data: unknown }   // validated against expectedOutput.schema
  | { kind: 'repo'; branch?: string; commit?: string; diffStat?: { files: number; insertions: number; deletions: number }; prUrl?: string }
  | { kind: 'external'; system: ExternalSystem; handle: string; idempotencyKey: string; url?: string }
  | { kind: 'binary'; attachmentId: string; mime: string; bytes: number }
  | { kind: 'action'; tool: string; count: number };

// ── Acceptance predicates: v1 set + 4 new for the new mechanisms ──
export type AcceptancePredicate =
  // v1 (unchanged)
  | { kind: 'files_exist'; paths: string[]; min_size_bytes?: number }
  | { kind: 'fields_populated'; keys: string[] }
  | { kind: 'field_matches'; key: string; pattern: string }
  | { kind: 'bash_exit_zero'; command: string; cwd?: 'worktree' | 'project' }
  | { kind: 'attachments_present'; names: string[] }
  | { kind: 'body_contains'; pattern: string; regex?: boolean }
  | { kind: 'child_work_items_done'; count?: number; all?: boolean }
  // new
  | { kind: 'schema_valid'; schema: JsonSchema }                 // payload
  | { kind: 'git_diff_nonempty'; cwd?: 'worktree' | 'project' }  // repo
  | { kind: 'external_handle_present' }                          // external
  | { kind: 'tool_called'; name: string; min_count?: number }    // action — reads the run transcript
  | { kind: 'pending_ask_created' }                              // action — durable side-effect of pc_ask_user
  | { kind: 'report_contains'; pattern: string; regex?: boolean }; // answer (report text, not WI body)

export type AcceptanceCriteria = AcceptancePredicate[];
export type ContractStatus =
  | 'issued' | 'dispatched' | 'submitted' | 'verifying' | 'accepted' | 'rejected';
```

### Derivation deltas (extend `deriveAcceptanceCriteria`)
- `answer` → `report_contains` per `must_address` + min-chars regex
- `prose` → `body_contains` per section + min-chars
- `payload` → `schema_valid`
- `repo` → `files_exist` (paths_touched) + `git_diff_nonempty` (if require_diff) + `bash_exit_zero` per check
- `external` → `external_handle_present` (+ optional handle existence-check)
- `binary` → `attachments_present` + size
- `action` → `tool_called` (+ `pending_ask_created` for `pc_ask_user`)

## Reliability — submission-gated completion

Today's model is **trust-then-inspect**: prose tells the agent what to do, it free-forms a write, the turn ends on `end_turn`, then predicates check. Flip to **submission-as-typed-tool-call**:

1. **Know.** The `expectedOutput` schema is injected as the input schema of a dedicated MCP tool — `pc_submit_deliverable`. The agent learns the exact shape from the tool it must call, not from prose it can skim.
2. **Happen reliably.** Completion = *an accepted submission*, not `end_turn`. The MCP server validates the payload against the schema and returns error-to-retry on mismatch, in-band. Ending a turn without a valid submission ⇒ re-prompt ("you haven't submitted; the contract requires …"). This is the ready-ping/mailbox pattern inverted: withhold acceptance until the deliverable lands.

Two enforcement classes: structured/text → schema-validated payload (deterministic); side-effect (repo/external/action) → the submission is a "done" claim and predicates gate acceptance against the environment/transcript.

Bonus: for structured deliverables this retires the echo-ack / paste-ref plumbing — the deliverable is a tool call captured via JSONL, not a giant bracketed-paste blob.

## The verification defect (the proof case)

Live run `01KSZZKQ6JY68A60SMX1VE01BD` (pod `haiku`): a contract whose whole point was "your FIRST action MUST be `pc_ask_user`, then end your turn." The agent never called `pc_ask_user` — it echoed the instructions into the work-item body — yet the run completed, the WI flipped to `complete`, and tier-1 reported `verification: passed`.

**Root cause (from `agent-verification.ts`), classified (c) both, structural primary:**
1. `EvaluationContext` (lines 185–193) carries only `body`, `fields`, `attachments`, `childWorkItems` — all resulting artifacts. There is **no handle to the run's tool-call stream**, so no predicate can assert "`pc_ask_user` was called." Auto-tier is structurally incapable of verifying an action contract.
2. `body_contains` searches body + attachments → satisfied by echoing the prompt. The orchestrator reached for it because nothing better existed (authoring symptom downstream of #1).
3. Auto-tier **passes by default** (lines 161–181): empty AC → `verification_status: 'passed'`. An `action`/`side-effect` contract with no `verify_via_bash` derives to `[]` → silent pass. An auto-verifier with nothing meaningful to check must **fail closed**, not pass open.

**Status: OPEN.** A point-fix was scoped and handed to a parallel agent that has since moved on — **assume it did NOT land** until verified in the code. The scoped subset (for whoever picks it up, point-fix or slice 014): extend `EvaluationContext` with the run's tool-call list; add the `tool_called` predicate (fall back to `pending_ask_created` DB check if JSONL plumbing is too deep); flip the pass-by-default so an action/side-effect contract with no action-evidence predicate escalates to `orchestrator-review` instead of auto-passing; echo-poisoning guardrail (reject `body_contains` whose needle appears verbatim in the prompt/AC); repro test (echoes AC, never calls the tool → must NOT pass).

**Slice 014 owns the defect.** First check whether the point-fix subset already exists in the code; promote it if so, otherwise build it. Either way 014 makes `action` a first-class deliverable kind, adds `tool_called`/`pending_ask_created` to the predicate union, and makes submission-gated completion the *completion condition* — so a contract can't even reach `completed` without the evidence.

## Open forks
- **payload schema vs. closed-world variable catalog** — decomposition/extraction payloads will reference catalog-typed fields. Keep `JsonSchema` independent now; bridge to the catalog later.
- **prose default store** — defaulted to `work_item_body` when a WI is linked, else `attachment` (per the DB-attachments rule). Revisit if reading docs off the WI feels wrong.
- **Queue position** — appended as 013/014 after 012 (pathway intact). Reprioritize ahead of Areas only if the verification bleed isn't contained by the live point-fix.

## Slice breakdown
- **013 — Agent contracts as a first-class entity + work log.** New `agent_contracts` table; deliverable owned by contract; optional `workItemId` FK (1:many); migrate the `work_items` contract fields; `ContractService`; work-item inspector renders associated contracts as a timeline (the "work log"). Additive + decoupling; no behavior change to verification. Plan doc: `build-slices/013-agent-contracts-first-class.md`.
- **014 — Reliable deliverables: taxonomy + submission-gated verification.** The 7-mechanism `ExpectedOutput`/`Deliverable` union; extended predicate set; `EvaluationContext` gains the tool-call stream; fail-closed auto-tier; `pc_submit_deliverable` + completion gated on accepted submission. Promotes the live verification point-fix. Plan doc: `build-slices/014-reliable-deliverables.md` (written in its own planning session).
- **015 (cleanup, optional):** remove `is_agent_task`/`ephemeral`/`assigned_agent_run_id` from `work_items` once nothing reads them. May fold into the 012 compatibility cleanup instead.
