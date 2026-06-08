import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Short label surfaced in the fallback message ("chat", "activity", etc.). */
  label?: string;
  /** Override the default compact fallback. */
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors in a subtree and shows a compact fallback instead of
 * propagating the crash upward. Use React's `key` prop on this component to
 * force a clean remount when navigating (e.g. closing a modal, switching
 * projects). The "Try again" button resets internal state for transient errors.
 *
 * Error route: `console.error` → captured by Electron's renderer diagnostics
 * (renderer-console.log via the console-message IPC hook in main.ts).
 */
export class ErrorBoundary extends Component<Props, State> {
  static getDerivedStateFromError(_error: Error): State {
    return { error: _error };
  }

  override state: State = { error: null };

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Routed to renderer-console.log via Electron's console-message capture.
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    if (this.props.fallback !== undefined) return this.props.fallback;

    const where = this.props.label ?? 'this panel';
    return (
      <div
        data-testid="error-boundary-fallback"
        className="flex h-full flex-col items-center justify-center gap-2 p-4 text-xs"
      >
        <span className="text-destructive">
          {where.charAt(0).toUpperCase() + where.slice(1)} hit an error.
        </span>
        <button
          type="button"
          onClick={this.handleReset}
          className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          Try again
        </button>
      </div>
    );
  }
}
