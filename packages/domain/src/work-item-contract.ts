// Work-item-as-contract types. Section 26 v1 — every agent dispatch creates
// a work item; the work item IS the contract. See the agent output contract.
//
// Slice 013 — this v1 union STAYS authoritative for the legacy `work_items`
// contract columns (dual-read shim) until slice 014 supersedes it. The v2
// first-class union lives in `contract.ts` (exported as `ContractV2`). Do NOT
// collapse this into a re-export this slice — verification must stay byte-
// identical and `deriveAcceptanceCriteria` / `agent-work-item.ts` consume these
// exact v1 shapes (`text`/`files`/`structured`/`side-effect`/`mixed`).

/** Who verifies "done". `auto` runs structured predicates; `orchestrator-review`
 *  wakes the orchestrator via channel event; `human-review` queues in the
 *  Human Review inbox. */
export const VERIFICATION_TIERS = ['auto', 'orchestrator-review', 'human-review'] as const;
export type VerificationTier = (typeof VERIFICATION_TIERS)[number];

export function isVerificationTier(value: unknown): value is VerificationTier {
  return typeof value === 'string' && (VERIFICATION_TIERS as readonly string[]).includes(value);
}

/** Runtime state for the verification pass. `null` means verification hasn't
 *  run yet (work item still in-flight). */
export const VERIFICATION_STATUSES = ['pending', 'passed', 'failed'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Structured acceptance-criteria predicate. v1 set; the predicate language is
 *  shared with future workflow-runtime + DOD predicates. */
export type AcceptancePredicate =
  | { kind: 'files_exist'; paths: string[]; min_size_bytes?: number }
  | { kind: 'fields_populated'; keys: string[] }
  | { kind: 'field_matches'; key: string; pattern: string }
  | { kind: 'bash_exit_zero'; command: string; cwd?: 'worktree' | 'project' }
  | { kind: 'attachments_present'; names: string[] }
  | { kind: 'body_contains'; pattern: string; regex?: boolean }
  | { kind: 'child_work_items_done'; count?: number; all?: boolean };

export const ACCEPTANCE_PREDICATE_KINDS = [
  'files_exist',
  'fields_populated',
  'field_matches',
  'bash_exit_zero',
  'attachments_present',
  'body_contains',
  'child_work_items_done',
] as const;
export type AcceptancePredicateKind = (typeof ACCEPTANCE_PREDICATE_KINDS)[number];

/** Persisted on the work item; an empty array means "no auto-checks". */
export type AcceptanceCriteria = AcceptancePredicate[];

/** Orchestrator's input spec for `pc_create_agent_work_item`. AC is derived
 *  from this; both are persisted so the rules can be re-applied if derivation
 *  changes. */
export type ExpectedOutput =
  | { kind: 'text'; sections?: string[]; min_chars?: number }
  | { kind: 'files'; paths: string[]; min_size_bytes?: number }
  | {
      kind: 'structured';
      fields: Record<string, 'string' | 'number' | 'boolean' | 'object'>;
    }
  | { kind: 'side-effect'; describe: string; verify_via_bash?: string }
  | {
      kind: 'mixed';
      text?: { sections?: string[]; min_chars?: number };
      files?: { paths: string[]; min_size_bytes?: number };
      structured?: { fields: Record<string, 'string' | 'number' | 'boolean' | 'object'> };
      side_effect?: { describe: string; verify_via_bash?: string };
    };

export const EXPECTED_OUTPUT_KINDS = [
  'text',
  'files',
  'structured',
  'side-effect',
  'mixed',
] as const;
export type ExpectedOutputKind = (typeof EXPECTED_OUTPUT_KINDS)[number];
