import type { ReactNode } from 'react';

import type { OrchestratorSurfacePreference } from '@/features/settings/client';
import type { RuntimeInputCapabilities } from '@/features/chat/runtimeState';
import type { WsEnvelope, WsStatus } from '@/features/runtime/ws-types';

export interface ChatSurfaceProps {
  /** Per-project WS-shaped envelope stream (event / jsonl / ask / state / turn-end / etc).
   *  Wrappers adapt their source-of-truth into this shape before passing in.
   *  Does NOT contain raw PTY frames — those flow via rawEvents below. */
  events: WsEnvelope[];
  /** Raw PTY frame envelopes only. Keyed on terminalRaw in the reducer so it
   *  changes per 50 ms terminal batch without touching the chat events[] identity.
   *  Pass to TerminalPane instead of events to prevent chat timeline recomputes. */
  rawEvents?: WsEnvelope[];
  /** Project id - needed for AskCard reply POST. */
  projectId: string;
  /** Current session id (orchestrator session ULID, or null when unknown).
   *  Used to scope `ask` envelopes to this session. */
  currentSessionId: string | null;
  /** Composer send. The orchestrator wrapper wires this to the WS `send`. */
  onSend: (text: string, clientMessageId: string) => boolean;
  /** Composer interrupt. */
  onInterrupt: () => boolean;
  /** Raw xterm input. Present only on the live orchestrator surface. */
  onTerminalInput?: (data: string) => boolean;
  /** Terminal resize. Present only on the live orchestrator surface. */
  onTerminalResize?: (cols: number, rows: number) => boolean;
  /** Optional ask-card reply (orchestrator only - wires to WS `ask-reply`).
   *  When omitted, ask cards never appear because the session-id filter drops
   *  them; safe to leave undefined for agent-designer surface. */
  onAskReply?: (toolUseId: string, answer: string) => boolean;
  /** localStorage partition for prompt history (per-project / per-surface). */
  composerHistoryKey: string;
  defaultOrchestratorSurface?: OrchestratorSurfacePreference;
  /** Hide composer entirely - past-session view. */
  composerHidden?: boolean;
  /** Disable composer input + send/interrupt buttons. Used for agent-designer
   *  spawn / exited states where the composer is structurally present but
   *  input isn't yet (or no longer) accepted. */
  composerDisabled?: boolean;
  /** Keep the textarea editable, but prevent submitting. Used during a
   *  new-session transition so drafts don't leak into the previous session. */
  composerSendDisabled?: boolean;
  /** Override composer placeholder. Defaults to the orchestrator string. */
  composerPlaceholder?: string;
  /** User-facing reason when the composer is disabled but still visible. */
  composerDisabledReason?: string;
  /** Server-derived queueable runtime state (busy/spawning/respawning). */
  composerQueueing?: boolean;
  /** Server-derived send button label. */
  composerSendLabel?: string;
  /** Unified runtime input gate. When supplied, it is the source of truth for
   *  composer send, interrupt, terminal input, and terminal resize. */
  inputCapabilities?: RuntimeInputCapabilities;
  /** Non-blocking status text shown in the composer chrome. */
  composerStatusMessage?: string;
  /** Optional content above the chat scroller (session title row, agent label, etc.). */
  headerSlot?: ReactNode;
  /** Optional content between scroller and composer (e.g. session-ended notice). */
  bannerSlot?: ReactNode;
  /** Optional content below composer (e.g. StatusBar). */
  footerSlot?: ReactNode;
  /** Content rendered when there are no events to show. */
  emptyState?: ReactNode;
  /** Connection status of the WS feeding `events`. When the socket drops
   *  mid-turn the thinking indicator shows a "Reconnecting..." notice instead
   *  of a misleading live "Thinking" with a climbing timer. Transient
   *  surfaces that manage their own lifecycle omit this. */
  wsStatus?: WsStatus;
  /** Reports the active surface to parent shells that need to adapt their
   *  surrounding layout, such as hiding side previews while xterm is active. */
  onSurfaceModeChange?: (mode: OrchestratorSurfacePreference) => void;
}
