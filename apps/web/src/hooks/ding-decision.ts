// Pure decision function for the notification ding.
// No side effects — fully testable without a browser or React.

export const DING_DEBOUNCE_MS = 3_000;

export interface ShouldDingInput {
  /** Unread project ids from the PREVIOUS evaluation. */
  prevUnreadProjectIds: ReadonlySet<string>;
  /** Unread project ids from the CURRENT evaluation. */
  nextUnreadProjectIds: ReadonlySet<string>;
  /** The project the user is currently looking at (null = none). */
  activeProjectId: string | null;
  /**
   * True when a NEW qualifying unread-chat event arrived on the active
   * project's event stream since the last evaluation. The caller is
   * responsible for tracking which events have already been processed.
   */
  hasNewActiveUnreadEvent: boolean;
  /** Whether the browser window currently has focus. */
  windowFocused: boolean;
  /** Timestamp (ms) of the last ding that actually played. */
  lastDingTimestamp: number;
  /** When true the user has muted notification sounds. */
  muted: boolean;
  /** Debounce window in ms (default DING_DEBOUNCE_MS). */
  debounceMs?: number;
  /** Current time in ms (passed explicitly so the function is pure). */
  nowMs: number;
}

/**
 * Returns true when the ding should play.
 *
 * Ding when an unread chat event arrives that the user is NOT looking at:
 *   (a) A NON-active project transitions into the unread set.
 *   (b) The ACTIVE project receives a new qualifying event AND the window
 *       is not focused.
 * Never ding when muted or within the debounce window.
 */
export function shouldDing(input: ShouldDingInput): boolean {
  const {
    prevUnreadProjectIds,
    nextUnreadProjectIds,
    activeProjectId,
    hasNewActiveUnreadEvent,
    windowFocused,
    lastDingTimestamp,
    muted,
    debounceMs = DING_DEBOUNCE_MS,
    nowMs,
  } = input;

  if (muted) return false;
  if (nowMs - lastDingTimestamp < debounceMs) return false;

  // Case (a): a non-active project newly entered the unread set.
  for (const id of nextUnreadProjectIds) {
    if (!prevUnreadProjectIds.has(id) && id !== activeProjectId) {
      return true;
    }
  }

  // Case (b): active project has a new qualifying event and window is unfocused.
  if (hasNewActiveUnreadEvent && !windowFocused) {
    return true;
  }

  return false;
}
