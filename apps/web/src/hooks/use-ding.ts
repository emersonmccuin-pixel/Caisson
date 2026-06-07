import { useEffect, useRef } from 'react';

import type { WsEnvelope } from '@/features/runtime/ws-types';
import { isUnreadChatEvent } from '@/hooks/use-project-unread';
import { shouldDing } from '@/hooks/ding-decision';
import { useNotificationDingEnabled } from '@/hooks/use-notification-settings';
import { playDing } from '@/utils/ding-audio';

interface UseDingArgs {
  unreadProjectIds: ReadonlySet<string>;
  activeProjectId: string | null;
  activeEvents: WsEnvelope[];
}

/**
 * Side-effecty shell around shouldDing.
 *
 * Fires a soft ding when:
 *   (a) a non-active project newly enters unreadProjectIds, OR
 *   (b) the active project receives a new qualifying chat event and the
 *       window is not focused.
 *
 * Wire this where useProjectUnread is consumed (App.tsx).
 */
export function useDing({ unreadProjectIds, activeProjectId, activeEvents }: UseDingArgs): void {
  const [enabled] = useNotificationDingEnabled();

  // --- refs (stable across renders) ---
  const windowFocusedRef = useRef(typeof document !== 'undefined' ? document.hasFocus() : true);
  const lastDingRef = useRef(0);
  const prevUnreadRef = useRef<ReadonlySet<string>>(new Set<string>());
  const lastActiveProjectIdRef = useRef<string | null | undefined>(undefined); // undefined = not yet initialized
  const processedActiveCountRef = useRef(0);

  // Track window focus via native events (focus/blur on window).
  useEffect(() => {
    function onFocus() { windowFocusedRef.current = true; }
    function onBlur() { windowFocusedRef.current = false; }
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Main ding evaluation — runs whenever inputs change.
  useEffect(() => {
    const isFirstRun = lastActiveProjectIdRef.current === undefined;
    const projectSwitched = lastActiveProjectIdRef.current !== activeProjectId;

    if (isFirstRun || projectSwitched) {
      // Sync baseline — skip all existing events and unread state so we
      // don't ding for things the user already saw before this hook started
      // or for the old project's events.
      lastActiveProjectIdRef.current = activeProjectId;
      processedActiveCountRef.current = activeEvents.length;
      prevUnreadRef.current = unreadProjectIds;
      return; // no ding on first run or project switch
    }

    // Check for new qualifying events on the active stream.
    let hasNewActiveUnreadEvent = false;
    for (let i = processedActiveCountRef.current; i < activeEvents.length; i++) {
      const env = activeEvents[i]!;
      if (isUnreadChatEvent(env.type, env.event)) {
        hasNewActiveUnreadEvent = true;
      }
    }
    processedActiveCountRef.current = activeEvents.length;

    const ding = shouldDing({
      prevUnreadProjectIds: prevUnreadRef.current,
      nextUnreadProjectIds: unreadProjectIds,
      activeProjectId,
      hasNewActiveUnreadEvent,
      windowFocused: windowFocusedRef.current,
      lastDingTimestamp: lastDingRef.current,
      muted: !enabled,
      nowMs: Date.now(),
    });

    // Always advance prev so future diffs are correct.
    prevUnreadRef.current = unreadProjectIds;

    if (ding) {
      lastDingRef.current = Date.now();
      playDing();
    }
  }, [unreadProjectIds, activeProjectId, activeEvents, enabled]);
}
