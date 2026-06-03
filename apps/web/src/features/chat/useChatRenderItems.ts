import { useMemo } from 'react';

import { parseSystemTurnMarker, rowPolicy } from '@pc/runtime/chat-policy';

import type { JsonlEvent, WsEnvelope } from '@/features/runtime/ws-types';
import { injectTodoSnapshots, normalizeJsonlEnvelope } from '@/features/chat/normalizeJsonlEnvelope';
import { synthesizeRenderItems } from '@/features/chat/toolGrouping';
import { pendingPromptEnvelope } from '@/features/chat/usePendingPrompts';
import type { PendingPrompt, RenderItem, StableEnvelope } from '@/features/chat/types';

/** Stage 3 debug-reveal shape for a hidden row that normalizeJsonlEnvelope can't
 *  map (internal kinds). Reuses the system-row renderer so the reveal needs no
 *  new UI. */
function debugRevealEnvelope(env: WsEnvelope, ev: JsonlEvent): WsEnvelope {
  return {
    projectId: env.projectId,
    type: 'event',
    event: {
      kind: 'system',
      subtype: `debug:${ev.kind}`,
      level: 'debug',
      message: ev.kind,
      raw: ev,
    },
  };
}

interface BuildEnvelopesArgs {
  events: WsEnvelope[];
  currentSessionId: string | null;
  projectId: string;
  visiblePendingPrompts: PendingPrompt[];
  revealHidden?: boolean;
  /** FD-6 — hide mailbox-injected system messages (`[pc:…]` marked user turns).
   *  Default false: system messages are SHOWN. */
  hideSystem?: boolean;
}

/**
 * Stage 2 (docs/chat-canonical-source-redesign.md): build chat envelopes from
 * the canonical JSONL stream only. Differs from the legacy path by dropping
 * `type:'event'` CONTENT — the dual-source that caused duplicates/reordering.
 * Kept inputs:
 *   - `jsonl` rows: the durable, complete, seq-ordered transcript (the reducer's
 *     sequenced buffer already orders these by seq, so a filter preserves order;
 *     we never sort by array index).
 *   - `ask` prompts: live approval requests that are legitimately NOT in the
 *     transcript (a "truly-live signal" per the ADR's WS role).
 *   - synthetic `todos` events emitted by injectTodoSnapshots.
 * Suppression here still rides normalizeJsonlEnvelope's null-returns, whose
 * hidden set is proven equal to rowPolicy()'s in chat-policy.test.ts; Stage 3
 * swaps it for explicit policy + a debug reveal.
 */
export function buildCanonicalChatEnvelopes({
  events,
  currentSessionId,
  projectId,
  visiblePendingPrompts,
  revealHidden = false,
  hideSystem = false,
}: BuildEnvelopesArgs): StableEnvelope[] {
  const content = events.filter((env) => env.type === 'jsonl' || env.type === 'ask');
  const withTodos = injectTodoSnapshots(content);
  const out: StableEnvelope[] = [];
  for (let i = 0; i < withTodos.length; i++) {
    const env = withTodos[i]!;
    if (env.type === 'ask') {
      const askSessionId = (env as { sessionId?: string | null }).sessionId;
      if (currentSessionId && askSessionId && askSessionId !== currentSessionId) continue;
      out.push({ origIdx: i, env });
      continue;
    }
    if (env.type === 'event') {
      // Only synthetic todos envelopes reach here (input was jsonl|ask only).
      out.push({ origIdx: i, env });
      continue;
    }
    if (env.type === 'jsonl') {
      // Stage 3: rowPolicy is the suppression authority. Hidden rows are filtered
      // at the view (revealable via the debug toggle), never dropped at parse.
      // normalizeJsonlEnvelope is now just the shape converter — its null set is
      // proven equal to policy's hidden set (chat-policy.test.ts), so the gate and
      // the converter agree. Stage 6 replaces the converter with a policy-driven one.
      const ev = env.event as JsonlEvent | undefined;
      if (!ev) continue;
      if (rowPolicy(ev).visibility === 'hidden' && !revealHidden) continue;
      // FD-6 — user-facing system-message filter (shown by default).
      if (
        hideSystem &&
        ev.kind === 'jsonl-user' &&
        parseSystemTurnMarker(ev.text ?? '')
      )
        continue;
      const normalized = normalizeJsonlEnvelope(env);
      if (normalized) out.push({ origIdx: i, env: normalized });
      else if (revealHidden) out.push({ origIdx: i, env: debugRevealEnvelope(env, ev) });
    }
  }
  for (let i = 0; i < visiblePendingPrompts.length; i++) {
    const pending = visiblePendingPrompts[i]!;
    out.push({
      origIdx: withTodos.length + i,
      key: `pending-${pending.id}`,
      env: pendingPromptEnvelope(projectId, pending),
    });
  }
  return out;
}

export function useChatRenderItems({
  events,
  currentSessionId,
  projectId,
  visiblePendingPrompts,
  canonical = false,
  revealHidden = false,
  hideSystem = false,
}: {
  events: WsEnvelope[];
  currentSessionId: string | null;
  projectId: string;
  visiblePendingPrompts: PendingPrompt[];
  canonical?: boolean;
  revealHidden?: boolean;
  hideSystem?: boolean;
}): { chatEnvelopes: StableEnvelope[]; renderItems: RenderItem[] } {
  const chatEnvelopes = useMemo<StableEnvelope[]>(() => {
    if (canonical) {
      return buildCanonicalChatEnvelopes({
        events,
        currentSessionId,
        projectId,
        visiblePendingPrompts,
        revealHidden,
        hideSystem,
      });
    }
    // --- legacy path (frozen; the trustworthy A/B baseline) ---
    const eventsWithTodos = injectTodoSnapshots(events);
    const out: StableEnvelope[] = [];
    for (let i = 0; i < eventsWithTodos.length; i++) {
      const env = eventsWithTodos[i]!;
      if (env.type === 'ask') {
        const askSessionId = (env as { sessionId?: string | null }).sessionId;
        if (currentSessionId && askSessionId && askSessionId !== currentSessionId) {
          continue;
        }
        out.push({ origIdx: i, env });
        continue;
      }
      if (env.type === 'event') {
        out.push({ origIdx: i, env });
        continue;
      }
      if (env.type === 'jsonl') {
        const normalized = normalizeJsonlEnvelope(env);
        if (normalized) {
          out.push({ origIdx: i, env: normalized });
        }
      }
    }
    for (let i = 0; i < visiblePendingPrompts.length; i++) {
      const pending = visiblePendingPrompts[i]!;
      out.push({
        origIdx: eventsWithTodos.length + i,
        key: `pending-${pending.id}`,
        env: pendingPromptEnvelope(projectId, pending),
      });
    }
    return out;
  }, [events, currentSessionId, projectId, visiblePendingPrompts, canonical, revealHidden, hideSystem]);

  const renderItems = useMemo(
    () => synthesizeRenderItems(chatEnvelopes),
    [chatEnvelopes],
  );

  return { chatEnvelopes, renderItems };
}
