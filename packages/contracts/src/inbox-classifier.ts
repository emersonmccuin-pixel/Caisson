// Inbox ownership classifier -- Phase 0.2 (pc-pty-chat-276.1).
// Single source of truth for "who owns this inbox item, is it human-visible,
// and does it require a decision?"
//
// ADDITIVE only: the existing isInboxVisibleKind / ACTIONABLE_MAILBOX_KINDS
// callers are NOT replaced here -- Phase 2.1 swaps them over.
// Pure function; zero side-effects; zero I/O.

import type { MailboxMessageKind } from './mailbox.ts';
import type { WorkflowReviewFlavor } from './workflow-runs.ts';

// ---- Classification result --------------------------------------------------

export interface InboxClassification {
  /** Who is responsible for acting on this item. */
  owner: 'human' | 'orchestrator';
  /** Whether the item should appear in the human-facing inbox rail. */
  humanVisible: boolean;
  /** Whether the item requires an explicit decision (approve / reject / answer). */
  actionable: boolean;
}

// ---- Classifier -------------------------------------------------------------

/**
 * Classify a mailbox item by kind and (for workflow-review) reviewer flavor.
 *
 * Rules:
 * - orchestrator-reviewer workflow-review gate -> not human-visible, not actionable
 * - human-reviewer workflow-review gate -> human-visible, actionable
 * - verification-review (contract human-tier) -> human-visible, actionable
 * - agent-ask-escalated -> human-visible, actionable
 * - raw agent-question -> orchestrator-owned, not human-visible
 * - info-only kinds (system-notice, workflow-first-run-review, etc.) -> not actionable
 * - orchestrator-addressed kinds (agent-approval, agent-stalled, ...) -> not human-visible
 *
 * The existing isInboxVisibleKind / ACTIONABLE_MAILBOX_KINDS are NOT replaced
 * here -- Phase 2.1 swaps the callers over to this function.
 */
export function classifyInboxItem(
  kind: MailboxMessageKind,
  flavor?: WorkflowReviewFlavor | null,
): InboxClassification {
  switch (kind) {
    case 'workflow-review':
      if (flavor === 'orchestrator') {
        return { owner: 'orchestrator', humanVisible: false, actionable: false };
      }
      // flavor === 'human' or unspecified -> default to human ownership
      return { owner: 'human', humanVisible: true, actionable: true };

    case 'verification-review':
      return { owner: 'human', humanVisible: true, actionable: true };

    case 'agent-ask-escalated':
      return { owner: 'human', humanVisible: true, actionable: true };

    // ---- Orchestrator-only kinds --------------------------------------------

    case 'agent-question':
      // Raw agent->orchestrator ask; never human-inbox material.
      return { owner: 'orchestrator', humanVisible: false, actionable: false };

    case 'agent-approval':
      return { owner: 'orchestrator', humanVisible: false, actionable: false };

    case 'agent-terminal':
      return { owner: 'orchestrator', humanVisible: false, actionable: false };

    case 'agent-stalled':
      return { owner: 'orchestrator', humanVisible: false, actionable: false };

    case 'workflow-run-failed':
      // User decision 2026-06-05: failed runs are run-history, not human decisions.
      return { owner: 'orchestrator', humanVisible: false, actionable: false };

    case 'workflow-first-run-review':
      // Nudge to the orchestrator; info-only.
      return { owner: 'orchestrator', humanVisible: false, actionable: false };

    case 'external-webhook':
      return { owner: 'orchestrator', humanVisible: false, actionable: false };

    case 'runtime-hook-ask':
      return { owner: 'orchestrator', humanVisible: false, actionable: false };

    case 'system-notice':
      // Info-only; never requires a decision.
      return { owner: 'orchestrator', humanVisible: false, actionable: false };
  }
}
