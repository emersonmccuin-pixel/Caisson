// Slice 013 — first-class agent contract (v2 schema).
//
// A contract is a machine assignment with a typed, verified output — NOT a work
// item. This file owns the v2 `ExpectedOutput` / `Deliverable` / acceptance-
// predicate union from `refactor plan docs/agent-contracts-and-deliverables.md`.
//
// The seven deliverable MECHANISMS (answer/prose/payload/repo/external/binary/
// action) collapse the ~20 semantic deliverable types onto a small capture+
// verify set. Each `ExpectedOutput.kind` selects a mechanism; the matching
// `Deliverable.kind` is what the work-log view renders, one renderer per kind.
//
// 013 wires the union FOR REAL (DTO, persistence, parsers) but does NOT change
// verification behavior — submission-gated enforcement + the reworked predicate
// engine are slice 014. Slice 023 deleted the legacy v1 work-item-contract.ts;
// this file (the v2 7-mechanism union) is now the single authority.
//
// Browser-safe: zero runtime deps.

export const VERIFICATION_TIERS = ['auto', 'orchestrator-review', 'human-review'] as const;
export type VerificationTier = (typeof VERIFICATION_TIERS)[number];

export const VERIFICATION_STATUSES = ['pending', 'passed', 'failed'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

// pc-pty-chat-415 (R5/R12) — accept ⇒ land. Landing state for repo-kind
// contracts produced in an isolated worktree: 'pending' (landing in flight —
// boot re-drives a crash), 'landed' (merge + push verified, receipts on the
// contract), 'conflict' (durable gate — a human/orchestrator resolves, then
// re-lands), 'failed' (mechanics error; retryable through the same door),
// 'abandoned' (explicit decision to discard unlanded work — the branch is
// PRESERVED and its tip recorded before the worktree dir is reclaimed).
// NULL = not applicable (non-repo kinds, workflow-owned runs — those land via
// the workflow merge node — and pre-415 history).
export const CONTRACT_LANDING_STATUSES = ['pending', 'landed', 'conflict', 'failed', 'abandoned'] as const;
export type ContractLandingStatus = (typeof CONTRACT_LANDING_STATUSES)[number];

export const DELIVERABLE_KINDS = [
  'answer',
  'prose',
  'payload',
  'repo',
  'external',
  'binary',
  'action',
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
  // `trust_end_turn`: explicit opt-in to auto-accept on an EMPTY acceptance set
  // (no must_address / min_chars). Without it, a bare `answer` escalates to
  // review instead of silently passing — closes the empty-contract auto-pass
  // (the 2026-06-07 spec-less-dispatch finding). The degenerate-answer stock
  // pods (agent-designer / workflow-builder / caisson) set it; everything else
  // must declare real criteria or accept the review gate.
  | { kind: 'answer'; must_address?: string[]; min_chars?: number; trust_end_turn?: boolean }
  | {
      kind: 'prose';
      doc_type?: ProseDocType;
      sections?: string[];
      min_chars?: number;
      store?: ProseStore; // default: 'contract' — the Work Contract is the result's home (FD-5/M5)
      path?: string; // required when store === 'repo_file'
    }
  | { kind: 'payload'; schema: JsonSchema; semantic?: PayloadSemantic }
  | {
      kind: 'repo';
      // pc-pty-chat-415 (R3) — `in_place` is DELETED, not deprecated. Code work
      // ALWAYS runs in an isolated worktree; isolation is derived from the kind,
      // never chosen per dispatch. The field survives (optional, single value)
      // only so stored specs that spell it out stay parseable.
      isolation?: 'worktree';
      paths_touched?: string[];
      checks?: RepoCheck[];
      require_diff?: boolean; // default true
    }
  | {
      kind: 'external';
      system: ExternalSystem;
      action: string; // 'send', 'create_event', 'create_ticket', …
      confirm: 'always' | 'pre-authorized';
      idempotency_key: string; // minted up-front by the issuer (phantom-UUID guard)
      verify_handle?: boolean; // default true
    }
  | { kind: 'binary'; artifact_type?: BinaryArtifactType; mime?: string; min_size_bytes?: number }
  | { kind: 'action'; tool: string; min_count?: number; before_end_turn?: boolean };

export const EXPECTED_OUTPUT_KINDS = [
  'answer',
  'prose',
  'payload',
  'repo',
  'external',
  'binary',
  'action',
] as const;
export type ExpectedOutputKind = (typeof EXPECTED_OUTPUT_KINDS)[number];

export type ProseDocType =
  | 'plan'
  | 'prd'
  | 'research'
  | 'design'
  | 'adr'
  | 'spec'
  | 'runbook'
  | 'summary'
  | 'postmortem'
  | 'note';
// M5 (FD-5) — ☠ 'work_item_body': the body is the human brief ONLY; results
// live on the contract. The variant is deleted, not deprecated.
export type ProseStore = 'contract' | 'attachment' | 'repo_file';
export type PayloadSemantic =
  | 'extraction'
  | 'classification'
  | 'decision'
  | 'verdict'
  | 'decomposition'
  | 'score';
export type RepoCheck =
  | { preset: 'build' | 'test' | 'lint'; timeout_ms?: number }
  | { command: string; cwd?: 'worktree' | 'project'; timeout_ms?: number };
export type BinaryArtifactType = 'diagram' | 'screenshot' | 'export' | 'dataset' | 'build';
export const EXTERNAL_SYSTEMS = ['email', 'calendar', 'chat', 'ticket', 'crm', 'api'] as const;
export type ExternalSystem = (typeof EXTERNAL_SYSTEMS)[number];

// ── Deliverable: the captured result. Mirror of ExpectedOutput by kind. ──
//    What the work-log view renders, one renderer per kind.
export type Deliverable =
  | { kind: 'answer'; text: string }
  | { kind: 'prose'; text?: string; attachmentId?: string; ref?: string }
  | { kind: 'payload'; data: unknown } // validated against expectedOutput.schema
  | {
      kind: 'repo';
      branch?: string;
      commit?: string;
      baseBranch?: string;
      baseCommit?: string;
      diffStat?: { files: number; insertions: number; deletions: number };
      prUrl?: string;
    }
  | { kind: 'external'; system: ExternalSystem; handle: string; idempotencyKey: string; url?: string }
  | { kind: 'binary'; attachmentId: string; mime: string; bytes: number }
  | { kind: 'action'; tool: string; count: number };

// ── Acceptance predicates: v1 set + 4 new for the new mechanisms ──
export type AcceptancePredicate =
  // v1 (unchanged)
  | { kind: 'files_exist'; paths: string[]; min_size_bytes?: number }
  | { kind: 'fields_populated'; keys: string[] }
  | { kind: 'field_matches'; key: string; pattern: string }
  | { kind: 'bash_exit_zero'; command: string; cwd?: 'worktree' | 'project'; timeout_ms?: number }
  | { kind: 'attachments_present'; names: string[] }
  | { kind: 'body_contains'; pattern: string; regex?: boolean }
  | { kind: 'child_work_items_done'; count?: number; all?: boolean }
  // new
  | { kind: 'schema_valid'; schema: JsonSchema } // payload
  | { kind: 'git_diff_nonempty'; cwd?: 'worktree' | 'project' } // repo
  | { kind: 'external_handle_present' } // external
  | { kind: 'tool_called'; name: string; min_count?: number } // action — reads the run transcript
  | { kind: 'pending_ask_created' } // action — durable side-effect of the ask tools
  | { kind: 'report_contains'; pattern: string; regex?: boolean } // answer (report text, not WI body)
  | { kind: 'min_length'; min: number }; // deliverable length check (measures deliverable, not report)

export const ACCEPTANCE_PREDICATE_KINDS = [
  'files_exist',
  'fields_populated',
  'field_matches',
  'bash_exit_zero',
  'attachments_present',
  'body_contains',
  'child_work_items_done',
  'schema_valid',
  'git_diff_nonempty',
  'external_handle_present',
  'tool_called',
  'pending_ask_created',
  'report_contains',
  'min_length',
] as const;
export type AcceptancePredicateKind = (typeof ACCEPTANCE_PREDICATE_KINDS)[number];

export type AcceptanceCriteria = AcceptancePredicate[];

// ── Predicate decidability classification ───────────────────────────────────
// Marks each predicate kind as either 'decidable' (a machine-computable check)
// or 'judgment' (requires a semantic judge — human or LLM). ALL current kinds
// are decidable; 'judgment' is reserved for a future `coverage_addressed`
// predicate that is NOT added now.
//
// This map is the canary: adding a new kind to ACCEPTANCE_PREDICATE_KINDS
// without classifying it here causes the predicate-decidability guardrail test
// to fail (packages/domain/test/predicate-decidability.test.ts).
export const PREDICATE_DECIDABILITY: Record<AcceptancePredicateKind, 'decidable' | 'judgment'> = {
  files_exist: 'decidable',
  fields_populated: 'decidable',
  field_matches: 'decidable',
  bash_exit_zero: 'decidable',
  attachments_present: 'decidable',
  body_contains: 'decidable',
  child_work_items_done: 'decidable',
  schema_valid: 'decidable',
  git_diff_nonempty: 'decidable',
  external_handle_present: 'decidable',
  tool_called: 'decidable',
  pending_ask_created: 'decidable',
  report_contains: 'decidable',
  min_length: 'decidable',
};

export function isDecidablePredicate(kind: AcceptancePredicateKind): boolean {
  return PREDICATE_DECIDABILITY[kind] === 'decidable';
}

export const CONTRACT_STATUSES = [
  'issued',
  'dispatched',
  'submitted',
  'verifying',
  'accepted',
  'rejected',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

// ── Guards ──────────────────────────────────────────────────────────────────

export function isVerificationTier(value: unknown): value is VerificationTier {
  return typeof value === 'string' && (VERIFICATION_TIERS as readonly string[]).includes(value);
}

export function isVerificationStatus(value: unknown): value is VerificationStatus {
  return typeof value === 'string' && (VERIFICATION_STATUSES as readonly string[]).includes(value);
}

export function isDeliverableKind(value: unknown): value is DeliverableKind {
  return typeof value === 'string' && (DELIVERABLE_KINDS as readonly string[]).includes(value);
}

export function isExpectedOutputKind(value: unknown): value is ExpectedOutputKind {
  return typeof value === 'string' && (EXPECTED_OUTPUT_KINDS as readonly string[]).includes(value);
}

export function isContractStatus(value: unknown): value is ContractStatus {
  return typeof value === 'string' && (CONTRACT_STATUSES as readonly string[]).includes(value);
}
