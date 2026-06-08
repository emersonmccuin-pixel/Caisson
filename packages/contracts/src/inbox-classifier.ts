// Inbox ownership classifier (pc-pty-chat-276.1 → pc-pty-chat-267 → pc-pty-chat-316).
// Provides `owner` (who acts on this item) and `actionable` (requires a decision).
//
// VISIBILITY IS NOT DERIVED HERE. The address is the single visibility door:
// `user-inbox` recipients are already filtered server-side on every inbox route
// (apps/server/src/features/mailbox/routes.ts addressKinds:['user-inbox']).
// The client renders exactly what the server returns — no second derivation.
// See: "Inbox & review model — what reaches the human, and how" context doc.
//
// Pure function; zero side-effects; zero I/O.

import type { MailboxMessageKind } from './mailbox.ts';
import type { WorkflowReviewFlavor } from './workflow-runs.ts';

// ---- Classification result --------------------------------------------------

export interface InboxClassification {
  /** Who is responsible for acting on this item. */
  owner: 'human' | 'orchestrator';
  /** Whether the item requires an explicit decision (approve / reject / answer). */
  actionable: boolean;
}

// ---- Classifier -------------------------------------------------------------

/**
 * Classify a mailbox item by kind and (for workflow-review) reviewer flavor.
 * Returns `owner` (routing hint) and `actionable` (decision required).
 *
 * Visibility is NOT determined here — the server already filters by address
 * (user-inbox vs. orchestrator-addressed). Callers must NOT use this to gate
 * what shows in the human inbox.
 *
 * Rules:
 * - orchestrator-reviewer workflow-review gate -> orchestrator-owned, not actionable
 * - human-reviewer workflow-review gate -> human-owned, actionable
 * - verification-review (contract human-tier) -> human-owned, actionable
 * - agent-ask-escalated -> human-owned, actionable
 * - raw agent-question -> orchestrator-owned, not actionable
 * - info-only kinds (system-notice, workflow-first-run-review, etc.) -> not actionable
 * - orchestrator-addressed kinds (agent-approval, agent-stalled, ...) -> orchestrator-owned
 */
export function classifyInboxItem(
  kind: MailboxMessageKind,
  flavor?: WorkflowReviewFlavor | null,
): InboxClassification {
  switch (kind) {
    case 'workflow-review':
      if (flavor === 'orchestrator') {
        return { owner: 'orchestrator', actionable: false };
      }
      // flavor === 'human' or unspecified -> default to human ownership
      return { owner: 'human', actionable: true };

    case 'verification-review':
      return { owner: 'human', actionable: true };

    case 'agent-ask-escalated':
      return { owner: 'human', actionable: true };

    // ---- Orchestrator-only kinds --------------------------------------------

    case 'agent-question':
      // Raw agent->orchestrator ask; never human-inbox material.
      return { owner: 'orchestrator', actionable: false };

    case 'agent-approval':
      return { owner: 'orchestrator', actionable: false };

    case 'agent-terminal':
      return { owner: 'orchestrator', actionable: false };

    case 'agent-stalled':
      return { owner: 'orchestrator', actionable: false };

    case 'workflow-run-failed':
      // User decision 2026-06-05: failed runs are run-history, not human decisions.
      return { owner: 'orchestrator', actionable: false };

    case 'workflow-first-run-review':
      // Nudge to the orchestrator; info-only.
      return { owner: 'orchestrator', actionable: false };

    case 'external-webhook':
      return { owner: 'orchestrator', actionable: false };

    case 'runtime-hook-ask':
      return { owner: 'orchestrator', actionable: false };

    case 'system-notice':
      // Info-only; never requires a decision.
      return { owner: 'orchestrator', actionable: false };
  }
}
