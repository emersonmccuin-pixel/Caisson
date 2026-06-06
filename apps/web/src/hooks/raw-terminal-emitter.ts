import type { WsEnvelope } from '@/features/runtime/ws-types';

/** Callback type for raw PTY batch subscribers. */
export type RawBatchCallback = (envs: WsEnvelope[]) => void;

/** Convenience alias — the exact shape of subscribeRawTerminal exposed by
 *  useProjectWs and threaded down to TerminalModePanel. */
export type SubscribeRawTerminal = (cb: RawBatchCallback) => () => void;

/**
 * Minimal push-subscriber emitter for raw PTY batches.
 *
 * Used by useProjectWs to deliver 50 ms terminal frame batches
 * imperatively to TerminalModePanel WITHOUT triggering React state
 * updates. The subscriber Set lives in a ref; raw frames never touch
 * the chat-session reducer or any React useMemo dep chain.
 */
export function createRawTerminalEmitter(): {
  subscribe: SubscribeRawTerminal;
  emit: (envs: WsEnvelope[]) => void;
} {
  const subs = new Set<RawBatchCallback>();
  return {
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    emit(envs) {
      for (const cb of subs) cb(envs);
    },
  };
}
