// Section 26 → contract-first (slice 021) — per-pod default `expected_output`
// shapes, now on the v2 contract union (`contract.ts`).
//
// A dispatch's contract gets its expected output from (in order): the caller's
// inline `expected_output`, the pod row's stored default, then this stock map.
// The acceptance criteria derive from the spec (`deriveAcceptanceCriteriaV2`).
//
// Decision-4: each default also declares whether its output needs a WORK-ITEM
// HOME. The dispatch reject guard is the authority at runtime (it reads
// `expectedOutputRequiresWorkItem`); the `requiresWorkItem` flag here mirrors
// that decision per stock pod so the table is legible in one place. A `false`
// means the pod's default output lives on the contract — dispatch contract-only,
// no work item required.
//
// Stock-only for v1. User-customised pods that want defaults must pass
// `expected_output` explicitly until a default column lands on the agents row.

import type { ExpectedOutput } from './contract.ts';
import { expectedOutputRequiresWorkItem } from './work-item-policy.ts';

/** A stock pod's default contract output + whether it needs a work-item home. */
export interface PodDefault {
  expectedOutput: ExpectedOutput;
  /** Decision-4: true ⇒ the default output must land in a work item (the
   *  dispatch needs a `workItemId`). Derived from `expectedOutput` via the
   *  policy fn, so the flag can never drift from the spec. */
  requiresWorkItem: boolean;
}

function podDefault(expectedOutput: ExpectedOutput): PodDefault {
  return { expectedOutput, requiresWorkItem: expectedOutputRequiresWorkItem(expectedOutput) };
}

const POD_DEFAULTS: Record<string, PodDefault> = {
  // Returns findings as a direct answer to the orchestrator; addresses a
  // summary of what it found. Lives on the contract — no work-item home.
  researcher: podDefault({ kind: 'answer', must_address: ['summary'] }),

  // Drafted prose. Contract-stored (the M5/FD-5 default); the orchestrator
  // sets `store: 'attachment'` (and links a work item) when the draft should
  // live as a document on a card.
  writer: podDefault({ kind: 'prose', store: 'contract' }),

  // Code changes land in the repo. Decision-4 leans repo ⇒ requires a
  // work-item home; in_place isolation by default (orchestrator overrides to
  // worktree per dispatch).
  'code-writer': podDefault({ kind: 'repo', isolation: 'in_place' }),

  // Reviewer's job is a structured verdict — a payload the orchestrator reads.
  // Lives on the contract.
  reviewer: podDefault({
    kind: 'payload',
    semantic: 'verdict',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        issues: { type: 'array' },
        recommendations: { type: 'array' },
      },
      required: ['verdict'],
    },
  }),

  // Planner returns an ordered plan as an answer. Substance check (non-trivial
  // plan passes); no literal-token dependency so different phrasings of a
  // valid plan don't false-fail (pc-pty-chat-265.1). Lives on the contract.
  planner: podDefault({ kind: 'answer', min_chars: 200 }),

  // Extractor's job IS structured — a payload matching the per-dispatch schema.
  // The default schema is a generic `extracted` object; orchestrator overrides.
  extractor: podDefault({
    kind: 'payload',
    semantic: 'extraction',
    schema: { type: 'object', properties: { extracted: { type: 'object' } } },
  }),

  // agent-designer holds a design conversation and uses pc_create_agent to
  // produce a pod. The "report" is the chat trail itself; the answer is the
  // degenerate deliverable. trust_end_turn: the work is the side-effect (the new
  // pod), so an empty acceptance set is intended to auto-accept, not escalate.
  'agent-designer': podDefault({ kind: 'answer', trust_end_turn: true }),

  // workflow-builder holds a design conversation and calls pc_publish_workflow
  // to produce a v2 workflow. The chat trail is the report; answer deliverable.
  'workflow-builder': podDefault({ kind: 'answer', trust_end_turn: true }),

  // caisson is the in-app PC specialist — answers questions + mutates config.
  // Free-form answer; no work-item home. trust_end_turn: a Q&A turn has no
  // structural criteria to check.
  caisson: podDefault({ kind: 'answer', trust_end_turn: true }),
};

/** Lookup a pod's full default (expected output + Decision-4 WI requirement).
 *  Returns `undefined` for unknown pod names (including orchestrator — it's not
 *  dispatchable). */
export function getPodDefault(podName: string): PodDefault | undefined {
  return POD_DEFAULTS[podName];
}

/** Lookup a pod's default `expected_output` (the v2 contract spec). Returns
 *  `undefined` for unknown pod names. */
export function getPodDefaultExpectedOutput(podName: string): ExpectedOutput | undefined {
  return POD_DEFAULTS[podName]?.expectedOutput;
}

/** Test-friendly read-only view of the underlying map. */
export const POD_DEFAULT_EXPECTED_OUTPUT: Readonly<Record<string, PodDefault>> = POD_DEFAULTS;
