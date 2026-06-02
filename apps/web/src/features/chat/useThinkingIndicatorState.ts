import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { WsEnvelope } from '@/features/runtime/ws-types';

import { deriveActivity } from './runtimeState';

const LAST_ENVELOPE_UPDATE_MIN_MS = 250;

export function useThinkingIndicatorState({
  events,
  isThinking,
}: {
  events: WsEnvelope[];
  isThinking: boolean;
}) {
  const activity = useMemo(() => deriveActivity(events), [events]);

  const [lastEnvelopeAt, setLastEnvelopeAt] = useState<number>(() => Date.now());
  const lastEnvelopeAtRef = useRef(lastEnvelopeAt);
  useEffect(() => {
    const now = Date.now();
    if (now - lastEnvelopeAtRef.current < LAST_ENVELOPE_UPDATE_MIN_MS) return;
    lastEnvelopeAtRef.current = now;
    setLastEnvelopeAt(now);
  }, [events.length]);

  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [interruptedAt, setInterruptedAt] = useState<number | null>(null);

  useEffect(() => {
    if (isThinking) {
      if (thinkingStartedAt === null) {
        setThinkingStartedAt(Date.now());
        setElapsedMs(0);
      }
    } else if (thinkingStartedAt !== null) {
      setThinkingStartedAt(null);
      setElapsedMs(0);
      setInterruptedAt(null);
    }
  }, [isThinking, thinkingStartedAt]);

  useEffect(() => {
    if (thinkingStartedAt === null) return;
    const tick = () => setElapsedMs(Date.now() - thinkingStartedAt);
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [thinkingStartedAt]);

  const markInterrupted = useCallback(() => {
    if (isThinking) setInterruptedAt(Date.now());
  }, [isThinking]);

  return {
    activity,
    elapsedMs,
    interruptedAt,
    lastEnvelopeAt,
    markInterrupted,
  };
}
