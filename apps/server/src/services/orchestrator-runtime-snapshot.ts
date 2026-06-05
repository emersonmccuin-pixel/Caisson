import { existsSync, statSync } from 'node:fs';

import type { ULID } from '@pc/domain';
import {
  countConversationEvents,
  getActiveOrchestratorSession,
  getConversationHighWaterSeq,
} from '@pc/db';
import { jsonlPathFor } from '@pc/runtime';

import {
  deriveRuntimeHealth,
  deriveRuntimeWaitPoint,
  type PtyLifecycleState,
  type RuntimeHealth,
  type RuntimeWaitPoint,
} from './orchestrator-runtime-health.ts';
import {
  sendQueueSnapshotPayload,
  type PublicSendQueueItem,
} from './orchestrator-send-queue-delivery.ts';

interface RuntimeFailureState {
  health: 'failed_resume' | 'provider_missing';
  reason: string;
  at: number;
}

interface RuntimeLifecycleState {
  lastActivityAt: number | null;
  lastJsonlAt: number | null;
  lastExitAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  failure: RuntimeFailureState | null;
}

export interface PublicRuntimeSnapshot {
  type: 'runtime-state';
  sessionId: ULID | null;
  provider: 'claude';
  providerSessionId: string | null;
  health: RuntimeHealth;
  waitPoint: RuntimeWaitPoint;
  ptyState: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  spawnAttemptId: string | null;
  spawnAttempt: number;
  lastReadyAt: number | null;
  nextRetryAt: number | null;
  lastExitAt: number | null;
  lastJsonlAt: number | null;
  lastActivityAt: number | null;
  failureReason: string | null;
  rawJsonlPath: string | null;
  rawJsonlExists: boolean;
  rawJsonlCursor: number | null;
  replayPath: string | null;
  replayExists: boolean;
  replayLineCount: number;
  replayHighWaterSeq: number;
  queueDepth: number;
  queue: PublicSendQueueItem[];
}

export interface RuntimeSnapshotRuntime {
  folderPath: string;
  sessionDataPath(sessionId: ULID): string;
  orchestratorPtyState(): PtyLifecycleState;
  orchestratorRuntimeSnapshot(): {
    spawnAttemptId: string | null;
    spawnAttempt: number;
    lastReadyAt: number | null;
    nextRetryAt: number | null;
    runtimeFailureReason: string | null;
  };
}

function classifyRuntimeFailure(message: string): RuntimeFailureState['health'] {
  return /no transcript|conversation found|provider session|jsonl|transcript/i.test(message)
    ? 'provider_missing'
    : 'failed_resume';
}

function fileMtimeMs(filePath: string | null): number | null {
  if (!filePath) return null;
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

export class OrchestratorRuntimeSnapshots {
  private readonly runtimeLifecycle = new Map<ULID, RuntimeLifecycleState>();

  noteActivity(projectId: ULID): void {
    this.lifecycleFor(projectId).lastActivityAt = Date.now();
  }

  noteJsonl(projectId: ULID): void {
    const state = this.lifecycleFor(projectId);
    const now = Date.now();
    state.lastActivityAt = now;
    state.lastJsonlAt = now;
  }

  clearFailure(projectId: ULID): void {
    this.lifecycleFor(projectId).failure = null;
  }

  clearExit(projectId: ULID): void {
    const state = this.lifecycleFor(projectId);
    state.lastExitAt = null;
    state.exitCode = null;
    state.exitSignal = null;
  }

  noteFailure(projectId: ULID, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.lifecycleFor(projectId).failure = {
      health: classifyRuntimeFailure(message),
      reason: message,
      at: Date.now(),
    };
  }

  noteExit(
    projectId: ULID,
    code: number | undefined,
    signal: string | undefined,
  ): void {
    const state = this.lifecycleFor(projectId);
    const now = Date.now();
    state.lastActivityAt = now;
    state.lastExitAt = now;
    state.exitCode = code ?? null;
    state.exitSignal = signal ?? null;
  }

  payload(projectId: ULID, runtime: RuntimeSnapshotRuntime): PublicRuntimeSnapshot {
    const active = getActiveOrchestratorSession(projectId);
    const lifecycle = this.lifecycleFor(projectId);
    const ptyState = runtime.orchestratorPtyState();
    const runtimeDetails = runtime.orchestratorRuntimeSnapshot();
    const health = deriveRuntimeHealth({
      ptyState,
      lastExitAt: lifecycle.lastExitAt,
      failureHealth: lifecycle.failure?.health ?? null,
    });
    const rawJsonlPath = active?.jsonlPath
      ?? (active?.providerSessionId ? jsonlPathFor(runtime.folderPath, active.providerSessionId) : null);
    const rawJsonlExists = rawJsonlPath ? existsSync(rawJsonlPath) : false;
    // M3b — the replay store is the conversation_events table, not a path.
    // The diagnostic fields survive the wire shape; counts come from the DB.
    const replayLineCount = active ? countConversationEvents(active.id) : 0;
    const replayHighWaterSeq = active ? getConversationHighWaterSeq(active.id) : 0;
    const queue = active ? sendQueueSnapshotPayload(active.id).items : [];
    const queueDepth = queue.filter((item) => item.status !== 'failed').length;
    const rawJsonlCursor = active ? active.jsonlLineCursor : null;
    const lastJsonlAt = lifecycle.lastJsonlAt ?? fileMtimeMs(rawJsonlPath);
    const waitPoint = deriveRuntimeWaitPoint({
      sessionId: active?.id ?? null,
      health,
      queueDepth,
      rawJsonlExists,
      lastJsonlAt,
    });

    return {
      type: 'runtime-state',
      sessionId: active?.id ?? null,
      provider: 'claude',
      providerSessionId: active?.providerSessionId ?? null,
      health,
      waitPoint,
      ptyState,
      exitCode: lifecycle.exitCode,
      exitSignal: lifecycle.exitSignal,
      spawnAttemptId: runtimeDetails.spawnAttemptId,
      spawnAttempt: runtimeDetails.spawnAttempt,
      lastReadyAt: runtimeDetails.lastReadyAt,
      nextRetryAt: runtimeDetails.nextRetryAt,
      lastExitAt: lifecycle.lastExitAt,
      lastJsonlAt,
      lastActivityAt: lifecycle.lastActivityAt ?? lastJsonlAt ?? active?.startedAt ?? null,
      failureReason: lifecycle.failure?.reason ?? runtimeDetails.runtimeFailureReason,
      rawJsonlPath,
      rawJsonlExists,
      rawJsonlCursor,
      replayPath: null,
      replayExists: replayLineCount > 0,
      replayLineCount,
      replayHighWaterSeq,
      queueDepth,
      queue,
    };
  }

  private lifecycleFor(projectId: ULID): RuntimeLifecycleState {
    let state = this.runtimeLifecycle.get(projectId);
    if (!state) {
      state = {
        lastActivityAt: null,
        lastJsonlAt: null,
        lastExitAt: null,
        exitCode: null,
        exitSignal: null,
        failure: null,
      };
      this.runtimeLifecycle.set(projectId, state);
    }
    return state;
  }
}
