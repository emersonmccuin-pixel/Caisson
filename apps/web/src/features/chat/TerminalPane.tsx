import {
  Bug,
  MessagesSquare,
  Terminal as TerminalIcon,
} from 'lucide-react';

import { TerminalModePanel } from '@/components/TerminalModePanel';
import type { OrchestratorSurfacePreference } from '@/features/settings/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';

export function TerminalPane({
  eligible,
  projectId,
  sessionId,
  events,
  active,
  writable,
  onInput,
  onResize,
}: {
  eligible: boolean;
  projectId: string;
  sessionId: string | null;
  events: WsEnvelope[];
  active: boolean;
  writable: boolean;
  onInput?: (data: string) => boolean;
  onResize?: (cols: number, rows: number) => boolean;
}) {
  if (!eligible || !onInput || !onResize) return null;
  return (
    <TerminalModePanel
      projectId={projectId}
      sessionId={sessionId}
      events={events}
      visible={active}
      writable={writable}
      onInput={onInput}
      onResize={onResize}
    />
  );
}

export function TerminalModeToggle({
  eligible,
  active,
  onModeChange,
}: {
  eligible: boolean;
  active: boolean;
  onModeChange: (mode: OrchestratorSurfacePreference) => void;
}) {
  if (!eligible) return null;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      data-testid="chat-mode-toggle"
      aria-label={active ? 'Terminal mode enabled' : 'Terminal mode disabled'}
      title={active ? 'Switch to chat mode' : 'Switch to terminal mode'}
      onClick={() => onModeChange(active ? 'chat' : 'terminal')}
      className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-background px-2.5 text-xs font-medium shadow-sm hover:border-primary/60"
    >
      <span
        className={
          'inline-flex items-center gap-1.5 ' +
          (active ? 'text-muted-foreground' : 'text-foreground')
        }
      >
        <MessagesSquare className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Chat</span>
      </span>
      <span
        aria-hidden="true"
        className={
          'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors ' +
          (active
            ? 'border-primary bg-primary'
            : 'border-border bg-muted')
        }
      >
        <span
          className={
            'h-4 w-4 rounded-full bg-background shadow-sm transition-transform ' +
            (active ? 'translate-x-4' : 'translate-x-0.5')
          }
        />
      </span>
      <span
        className={
          'inline-flex items-center gap-1.5 ' +
          (active ? 'text-foreground' : 'text-muted-foreground')
        }
      >
        <TerminalIcon className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Terminal</span>
      </span>
    </button>
  );
}

/** Diagnostic toggle: when on, the chat renders EVERY JSONL row labeled by its
 *  kind (including the kinds normally filtered out) so you can see exactly
 *  what's flowing through vs. being suppressed. Live — no reload — and persists
 *  via the same localStorage key the DevControls toggle uses. */
export function RawModeToggle({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      data-testid="chat-raw-mode-toggle"
      aria-label={active ? 'Raw mode enabled' : 'Raw mode disabled'}
      title={
        active
          ? 'Raw mode ON — every JSONL row is shown, labeled by kind. Click to hide diagnostic rows.'
          : 'Raw mode OFF — click to reveal every JSONL row labeled by kind (diagnostic).'
      }
      onClick={onToggle}
      className={
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium shadow-sm transition-colors ' +
        (active
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-border bg-background text-muted-foreground hover:border-primary/60')
      }
    >
      <Bug className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Raw</span>
      <span className={active ? 'text-primary' : 'text-muted-foreground'}>
        {active ? 'on' : 'off'}
      </span>
    </button>
  );
}
