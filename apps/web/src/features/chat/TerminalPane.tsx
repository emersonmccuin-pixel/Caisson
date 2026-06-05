import {
  MessagesSquare,
  Smartphone,
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

/** Read-only remote-control status light. Green when this session launched
 *  remote-ready (drivable from the Claude phone/web app), dark when not.
 *  It's an indicator, not a control — Claude can't be toggled on/off live from
 *  outside the terminal, so remote control is a launch setting (App / Project
 *  settings) and this just reflects it. */
export function RemoteStatusLed({ active }: { active: boolean }) {
  return (
    <span
      data-testid="chat-remote-status-led"
      aria-label={active ? 'Remote control on' : 'Remote control off'}
      title={
        active
          ? 'Remote control is ON for this session — drive it from the Claude phone/web app. Open the terminal view for the connect QR code. Change the default in App or Project settings.'
          : 'Remote control is OFF for this session. Turn it on by default in App or Project settings (takes effect on the next session).'
      }
      className={
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium ' +
        (active
          ? 'border-border bg-background text-foreground'
          : 'border-border bg-background text-muted-foreground')
      }
    >
      <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Remote</span>
      <span
        aria-hidden="true"
        className={
          'h-2 w-2 rounded-full ' +
          (active
            ? 'bg-success shadow-[0_0_6px_1px] shadow-success/70'
            : 'bg-muted-foreground/40')
        }
      />
    </span>
  );
}

