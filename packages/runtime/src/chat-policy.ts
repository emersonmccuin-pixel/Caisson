// Chat row presentation policy — the single place that decides, per canonical
// JSONL row, whether it shows in chat and in which lane. See
// docs/chat-canonical-source-redesign.md §2.
//
// Principle: parse everything, suppress at the VIEW, never at parse. `hidden`
// rows are filtered by the renderer (revealable by a debug toggle), never
// dropped from the store. Pure + framework-agnostic so the server replay path
// and the client renderer share one table (ADR open question #4).
//
// Stage 0: dormant. This table faithfully transcribes today's behavior — the
// `return null` suppressions in apps/web/.../normalizeJsonlEnvelope.ts and the
// SUPPRESSED_TOOLS set in toolGrouping.ts. The `hidden` set here MUST equal
// today's suppressed set (enforced by chat-policy.test.ts). Visible-vs-collapsed
// is a presentation detail that loses no information; only `hidden` gates
// whether a message reaches the user.

import type { JsonlEvent } from './jsonl-tailer.ts';

// ── FD-3 / FD-6 — the system-injected turn marker ─────────────────────────
// Every message the mailbox injects into an orchestrator PTY (it arrives as if
// a user typed it) is guaranteed to START with a `[pc:…]` header line — either
// a composer-specific one ([pc:agent-event kind=agent-completed …],
// [pc:workflow-review run=… node=…]) or the door's fallback
// ([pc:system kind=<mailbox-kind>]). The header IS the end-to-end tag: it
// survives verbatim into CC's JSONL transcript, so replay and live rendering
// see the same marker. Chat renders marked user rows as system messages and
// can filter them (shown by default per FD-6).

export const SYSTEM_TURN_MARKER_RE = /^\[pc:([a-z0-9][a-z0-9-]*)((?:[ \t][^\]\n]*)?)\]/;

export interface SystemTurnMarker {
  /** Best display kind: the `kind=` attribute when present, else the token
   *  after `pc:` (e.g. `workflow-review`). */
  kind: string;
}

/** Parse the marker off an injected turn's text. Null for ordinary human text. */
export function parseSystemTurnMarker(text: string): SystemTurnMarker | null {
  const m = SYSTEM_TURN_MARKER_RE.exec(text);
  if (!m) return null;
  const kindAttr = /(?:^|[ \t])kind=([a-z0-9][a-z0-9-]*)/.exec(m[2] ?? '');
  return { kind: kindAttr?.[1] ?? m[1]! };
}

/** Guarantee a marker at the ONE injection door. Text already carrying a
 *  `[pc:…]` first line passes through; anything else gets the fallback header. */
export function ensureSystemTurnMarker(text: string, kind: string): string {
  if (SYSTEM_TURN_MARKER_RE.test(text)) return text;
  const safeKind = kind.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'notice';
  return `[pc:system kind=${safeKind}]\n${text}`;
}

/** Display helper: drop the marker line (and one following blank line) so the
 *  rendered body starts with the human-readable content. */
export function stripSystemTurnMarkerLine(text: string): string {
  if (!SYSTEM_TURN_MARKER_RE.test(text)) return text;
  const nl = text.indexOf('\n');
  if (nl === -1) return '';
  return text.slice(nl + 1).replace(/^\n/, '');
}

/** Whether a row reaches the user, and how prominently. `hidden` rows are
 *  filtered at the view (debug-toggle revealable), not discarded. */
export type RowVisibility = 'shown' | 'collapsed' | 'hidden';

/** Which presentation lane a row belongs to when visible. Advisory for hidden
 *  rows (governs how a debug toggle would surface them). */
export type RowLane = 'chat' | 'tools' | 'system' | 'internal';

export interface RowPolicy {
  visibility: RowVisibility;
  lane: RowLane;
}

/** Tool names whose JSONL tool-call/result rows never render in chat — agent /
 *  task / todo / search orchestration noise. Migrated here from toolGrouping's
 *  SUPPRESSED_TOOLS so the table is the single source (toolGrouping's copy is
 *  deleted in Stage 3). */
export const INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  'Agent',
  'Task',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'TaskOutput',
  'ToolSearch',
]);

/** Classify one canonical JSONL row for chat rendering. Pure; depends only on
 *  the row itself (cross-row concerns like pairing a tool-result to a suppressed
 *  tool-call are resolved at the grouping layer, not here). */
export function rowPolicy(ev: JsonlEvent): RowPolicy {
  switch (ev.kind) {
    case 'jsonl-user':
      // FD-3/FD-6 — mailbox-injected turns carry the [pc:…] marker and render
      // in the system lane (distinct style + user-facing filter). Shown by
      // default; never hidden at the policy layer.
      return parseSystemTurnMarker(ev.text ?? '')
        ? { visibility: 'shown', lane: 'system' }
        : { visibility: 'shown', lane: 'chat' };

    case 'jsonl-turn-end':
      // Today: empty-text turn-end is dropped (normalizeJsonlEnvelope returns null).
      return { visibility: ev.text ? 'shown' : 'hidden', lane: 'chat' };

    case 'jsonl-tool-call':
      return {
        visibility: INTERNAL_TOOLS.has(ev.name) ? 'hidden' : 'collapsed',
        lane: 'tools',
      };

    case 'jsonl-tool-result':
      // Per-row default; result inherits its call's suppression at grouping time.
      return { visibility: 'collapsed', lane: 'tools' };

    case 'jsonl-tool-progress':
      return { visibility: 'collapsed', lane: 'tools' };

    case 'jsonl-usage':
      // Today: only surfaces as a turn-footer chip when speed is non-standard
      // or a cache miss happened; otherwise dropped.
      return {
        visibility:
          (ev.speed && ev.speed !== 'standard') || ev.cacheMissReason ? 'shown' : 'hidden',
        lane: 'system',
      };

    case 'jsonl-system':
      return { visibility: 'shown', lane: 'system' };

    case 'jsonl-session-state':
      return { visibility: 'shown', lane: 'system' };

    case 'jsonl-compact':
      return { visibility: 'shown', lane: 'system' };

    case 'jsonl-microcompact':
      return { visibility: 'shown', lane: 'system' };

    // --- Internal / never-rendered today (normalizeJsonlEnvelope returns null) ---
    case 'jsonl-queue-enqueue':
    case 'jsonl-queue-dequeue':
      return { visibility: 'hidden', lane: 'internal' };

    case 'jsonl-ai-title':
    case 'jsonl-last-prompt':
    case 'jsonl-file-history':
    case 'jsonl-bridge-session':
      return { visibility: 'hidden', lane: 'internal' };

    case 'jsonl-sidechain':
      // Sub-agent turns: shown in chat but collapsed by default (grouped into a
      // single expandable block). Reaches the user; never hidden.
      return { visibility: 'collapsed', lane: 'internal' };

    case 'jsonl-turn-duration':
    case 'jsonl-post-turn-summary':
      return { visibility: 'hidden', lane: 'system' };

    case 'jsonl-stream-event':
      return { visibility: 'hidden', lane: 'chat' };

    case 'jsonl-assistant-text':
      return { visibility: ev.text ? 'shown' : 'hidden', lane: 'chat' };

    case 'jsonl-thinking':
      return { visibility: ev.text ? 'shown' : 'hidden', lane: 'chat' };

    default: {
      // Compile-time exhaustiveness: a new JsonlEvent kind fails the build here
      // until it is given an explicit policy.
      const _exhaustive: never = ev;
      void _exhaustive;
      return { visibility: 'hidden', lane: 'internal' };
    }
  }
}
