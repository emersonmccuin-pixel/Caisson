import './diagnostics.ts'; // FIRST — arm crash capture before anything else loads

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import type {
  Project,
  ULID,
} from '@pc/domain';
import { parseMailboxAddress } from '@pc/contracts';
import {
  getActiveOrchestratorSession,
  getLatestLiveEventForEntity,
  getMailboxMessage,
  getMailboxRecipient,
  insertPostTurnSummary,
  getProjectById,
  listProjects,
  newId,
  pruneLiveOutbox,
  runMigrations,
  setOrchestratorSessionJsonlCursor,
  setOrchestratorSessionJsonlPath,
  setOrchestratorSessionTitle,
  workflowRunsV2Repo,
  type EnqueueMailboxMessageInput,
} from '@pc/db';
import {
  ConversationSendService,
  MailboxService,
  PendingInteractionService,
  reconcileWorkflowRunsOnBoot,
  RECONCILE_SCAN_STATUSES,
  WorkflowRunMutationGateway,
  type MailboxEnqueuePublication,
} from '@pc/app-services';
import { getDataDir } from '@pc/utils';

import {
  deliverNextQueuedPrompt,
  maybeAdvanceSendQueueConfirmation,
  sendQueueSnapshotPayload,
} from './services/orchestrator-send-queue-delivery.ts';
import { OrchestratorRuntimeSnapshots } from './services/orchestrator-runtime-snapshot.ts';
import { ProjectWebSocketHub } from './services/websocket-hub.ts';
import { LiveRelay } from './services/live-relay.ts';
import { announceSessionTitle } from './services/session-title-writer.ts';
import { createHostConnection, toHostHealthSnapshot } from './services/host-connection.ts';
import { announceHostHealth } from './services/host-health-writer.ts';
import { sweepStaleJsonl } from './services/jsonl-sweep.ts';
import { backfillStageFlags } from './services/stage-flags-backfill.ts';
import { ChannelServer, type ChannelEvent } from './services/channel-server.ts';
import { ProjectCreate } from './services/project-create.ts';
import { ProjectRegistry } from './services/project-registry.ts';
import type { ProjectRuntime } from './services/project-runtime.ts';
import { ProjectScaffold } from './services/project-scaffold.ts';
import { registerFileRoutes } from './features/files/routes.ts';
import { setBundledClaudeExe } from '@pc/runtime';
import {
  applyClaudeRuntimeSettings,
  readSettings,
  registerSettingsOnboardingRoutes,
} from './features/settings-onboarding/routes.ts';
import { createRuntimeHostPtyController } from './features/runtime-host/pty-handlers.ts';
import {
  registerProjectDetailRoute,
  registerProjectRoutes,
} from './features/projects/routes.ts';
import { registerRuntimeHostRoutes } from './features/runtime-host/routes.ts';
import { registerRuntimeHostWebSocketServer } from './features/runtime-host/websocket-server.ts';
import { registerTransientSessionRoutes } from './features/transient-sessions/routes.ts';
import { registerWorkItemRoutes } from './features/work-items/routes.ts';
import { registerAreaRoutes } from './features/areas/routes.ts';
import { registerContractRoutes } from './features/contracts/routes.ts';
import { registerAgentRunRoutes } from './features/agent-runs/routes.ts';
import { registerWorktreeRoutes } from './features/project-worktrees/routes.ts';
import { registerStatuslineRoutes } from './features/statusline/routes.ts';
import { registerLiveEventRoutes } from './features/live-events/routes.ts';
import { registerDevControlRoutes } from './features/dev-controls/routes.ts';
import { registerProjectContextRoutes } from './features/project-context/routes.ts';
import { registerWorkflowCompatRoutes } from './features/workflow-compat/routes.ts';
import { registerMcpBridgeRoutes } from './features/mcp-bridge/routes.ts';
import {
  createPendingAskStore,
  registerChatBridgeRoutes,
} from './features/chat-bridges/routes.ts';
import { registerMailboxRoutes } from './features/mailbox/routes.ts';
import { MailboxOrchestratorTurnAdapter } from './services/mailbox-orchestrator-turn-adapter.ts';
import { MailboxWorker } from './services/mailbox-worker.ts';
import { AskShadow, sweepOrphanedPendingInteractions } from './services/ask-shadow.ts';
import { registerPodRoutes } from './routes/pod-routes.ts';
import { registerWorkflowRoutes } from './routes/workflow-routes.ts';
import { seedOrchestratorPodIfMissing } from './services/orchestrator-pod-seed.ts';
import { cleanupLegacyProjectRuntimeFiles } from './services/legacy-runtime-cleanup.ts';
import { resetStockPodToDefault } from './services/stock-pod-reset.ts';
import { detectStockPodDrift, listCanonicalStockPodNames } from './services/pod-drift.ts';
import { seedStockPods } from './services/stock-pod-seed.ts';
import { reattachAgentRunsDuringServerBoot } from './services/agent-run-server-boot.ts';
import { reconcileAgentRunsAgainstHost } from './services/agent-host-reattach.ts';
import { sweepAgentRunLiveness } from './services/agent-run-liveness-sweep.ts';
import { sweepStallWarn } from './services/agent-run-stall-warn.ts';
import { getActiveRunRegistry } from './services/agent-active-runs.ts';
import { writeRunStatus } from './services/workflow-run-writer.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// apps/server/src/index.ts → trunk root is three levels up. In a packaged
// Electron build the server runs as a bundled `server.mjs` whose location
// bears no relation to the resource layout, so PC_ROOT (set by the desktop
// main process to the unpacked resources dir) overrides. PUBLIC / TEMPLATES /
// the scaffold trunk path all derive from ROOT, so they relocate with it.
const ROOT = process.env.PC_ROOT
  ? resolve(process.env.PC_ROOT)
  : resolve(__dirname, '..', '..', '..');
const PUBLIC = resolve(ROOT, 'apps', 'web', 'dist');
// Section 22.3 — single runtime contract: every server-internal data path
// resolves through `getDataDir()` (`PC_DATA_DIR` env or workspace-root/data).
// The persisted `dataDir` settings field is cosmetic/informational; changing
// it is rejected at PATCH time and the GET always surfaces this value.
const DATA = getDataDir();
const TEMPLATES = resolve(ROOT, 'templates');

const PORT = Number(process.env.PORT ?? 4040);
const CHANNEL_PORT = Number(process.env.CHANNEL_PORT ?? 8788);

// ROOT-relative so the staged `drizzle/` is found in a packaged build (where
// migrate.ts's __dirname points inside the bundle). Dev resolves to the trunk.
runMigrations(resolve(ROOT, 'packages', 'db', 'drizzle'));

// Section 10 — register the pinned, app-bundled claude (if this is a packaged
// build that shipped one). The desktop main process sets PC_BUNDLED_CLAUDE_EXE
// to the binary inside the app's resources dir before booting the server. The
// resolver uses it below explicit override/setting/CLAUDE_EXE but above PATH,
// so the app runs its pinned CLI by default while a power user can still point
// elsewhere. Dev (no bundle) leaves it null and falls through to PATH.
setBundledClaudeExe(process.env.PC_BUNDLED_CLAUDE_EXE ?? null);

// Section 10 / 33 — push stored Claude binary/profile overrides into runtime
// resolvers before any project PTY starts. The settings module captures the
// shell-inherited CLAUDE_CONFIG_DIR at import time so clearing an override can
// restore it later.
applyClaudeRuntimeSettings(readSettings());

// Section 16a.2 — seed the global orchestrator pod if it doesn't already
// exist. Idempotent on every boot; user/MCP edits to the row survive (the
// reseed path skips when any non-system audit row is present). 16a.3's
// spawn path depends on this row being live.
{
  const result = seedOrchestratorPodIfMissing();
  switch (result.action) {
    case 'inserted':
      console.log(`[pc] orchestrator pod seeded (id=${result.agentId})`);
      break;
    case 'reseeded':
      console.log(
        `[pc] orchestrator pod auto-reseeded (id=${result.agentId}, fields=[${result.reseededFields.join(', ')}])`,
      );
      break;
    case 'skipped-user-edited':
      console.warn(
        `[pc] orchestrator pod has drifted from ORCHESTRATOR_POD_CONTENT on fields [${result.reseededFields.join(', ')}] but the row has user-authored audit rows — leaving it alone. Apply the latest seed manually via the Pod UI (17d) or by clearing user edits.`,
      );
      break;
    case 'unchanged':
      break;
  }
}

// Stock specialist pods — insert-or-drift-reseed per pod. Non-user-edited
// rows auto-pick up source changes; user-edited rows are left intact and a
// warning is logged so the user knows their row has drifted. Researcher,
// writer, reviewer, planner, extractor, code-writer, agent-designer all
// flow through here. (The legacy `seedResearcherPodIfMissing` was retired
// when seedStockPods got drift-reseed parity — 2026-05-22 cleanup.)
{
  const result = seedStockPods();
  for (const entry of result.entries) {
    switch (entry.action) {
      case 'inserted':
        console.log(`[pc] stock pod '${entry.name}' seeded (id=${entry.agentId})`);
        break;
      case 'reseeded':
        console.log(
          `[pc] stock pod '${entry.name}' auto-reseeded (id=${entry.agentId}, fields=[${entry.reseededFields.join(', ')}])`,
        );
        break;
      case 'skipped-user-edited':
        console.warn(
          `[pc] stock pod '${entry.name}' has drifted from source on fields [${entry.reseededFields.join(', ')}] but the row has user-authored audit rows — leaving it alone. Use "Reset to default" in Global Settings → Specialists to pick up the seed.`,
        );
        break;
      case 'unchanged':
        break;
    }
  }
}

// Per-project WS subscriber hub. Multiple browser clients can observe the same
// project; reconnecting one client must not detach another from broadcasts.
const wsHub = new ProjectWebSocketHub<ULID>();

/**
 * Send `msg` to every WS subscribed to this project. P14: every outgoing
 * object envelope is tagged with `projectId` so UI clients can route events
 * to the right project's panel (and an "all projects" subscriber knows
 * where each event came from). An explicit `projectId` already on the
 * payload wins so call sites stay self-describing.
 */
function broadcastTo(projectId: ULID, msg: unknown): void {
  wsHub.broadcast(projectId, msg);
}

// Slice 015a — the single live-event relay. Drains committed `live_outbox` rows
// to the hub's subscribers per scope/project, and serves the per-socket
// subscribe handshake (cursor catch-up). It ships BESIDE the existing
// hand-written `broadcast*` fanout (dual delivery); the client dedupes by event
// `id` + per-entity `version`, so a row delivered by both paths is harmless.
// 015b deletes the legacy fanout subsystem-by-subsystem as the relay proves it.
// NEVER call relay.drain() inside a db.transaction(...) closure (ADR Non-goal).
const liveRelay = new LiveRelay({ hub: wsHub });
liveRelay.primeToHead();

const runtimeSnapshots = new OrchestratorRuntimeSnapshots();

function broadcastRuntimeSnapshot(projectId: ULID, runtime: ProjectRuntime): void {
  broadcastTo(projectId, runtimeSnapshots.payload(projectId, runtime));
}

function broadcastSendQueueSnapshot(projectId: ULID, sessionId: ULID): void {
  broadcastTo(projectId, sendQueueSnapshotPayload(sessionId));
  const runtime = resolveProject(projectId);
  if (runtime) broadcastRuntimeSnapshot(projectId, runtime);
}

const {
  attachPtyHandlers,
  ensureOrchestratorPty,
  startOrchestratorPtyInBackground,
} = createRuntimeHostPtyController<ReturnType<ProjectRuntime['ensurePty']>, ProjectRuntime>({
  runtimeSnapshots,
  getActiveOrchestratorSession,
  setOrchestratorSessionJsonlCursor,
  setOrchestratorSessionJsonlPath,
  broadcastTo,
  broadcastRuntimeSnapshot,
  broadcastSendQueueSnapshot,
  deliverNextQueuedPrompt,
  maybeAdvanceSendQueueConfirmation,
  maybeSetSessionTitle,
  maybeApplyAiTitle,
  maybePersistPostTurnSummary,
});

const projectScaffold = new ProjectScaffold({
  trunkPath: ROOT,
  templatesDir: TEMPLATES,
  dataDir: DATA,
  serverPort: PORT,
  channelPort: CHANNEL_PORT,
});

// T1.2 — host-mode discriminator. After D1, boot reattach runs on `hostConnection`
// and `result.mode === 'host'` is the authoritative host-mode signal that gates
// the reconcile + liveness sweeps (one reconciler owns non-terminal rows). NOT
// `hostConnection.isConnected()` — the always-on host may be mid-respawn
// (disconnected) while still in host-mode.
let hostMode = false;

// T1.1 — the one long-lived HostConnection for the DISPATCH path. Lock-file is
// the sole source of host identity; `sendCommand` re-discovers + reconnects on a
// dead baseUrl, so a host respawn on a new port is picked up with NO API restart
// (kills T1-A). T1.2 — ALL live host consumers (sweep, mcp-bridge, ProjectRegistry
// → factory/spawner, boot reattach) now ride this ONE conduit + its multiplexed
// event stream; the frozen per-boot client is gone. Health transitions write the
// durable global `host-health` live-event consumed by the UI pill.
const hostConnection = createHostConnection({ dataDir: DATA });
hostConnection.onHealthChange((h) => announceHostHealth(toHostHealthSnapshot(h)));

// Remove/quarantine legacy PC Claude runtime files from project roots before
// any Claude process starts. PC now passes session-local `--settings`,
// `--mcp-config`, and `--plugin-dir`; leaving old root files in place would
// still affect terminal-launched Claude Code in those folders.
{
  const result = cleanupLegacyProjectRuntimeFiles(listProjects({ includeDeleted: true }), {
    dataDir: DATA,
  });
  const changed = result.removed.length + result.rewritten.length;
  if (changed > 0) {
    console.log(
      `[pc] quarantined legacy Claude runtime files from ${changed} project file(s)`,
    );
  }
}

const projectRegistry = new ProjectRegistry({
  dataDir: DATA,
  templatesDir: TEMPLATES,
  trunkPath: ROOT,
  serverPort: PORT,
  channelPort: CHANNEL_PORT,
  getHostClient: () => hostConnection,
  broadcastFor: (projectId) => (event) => broadcastTo(projectId, event),
  // Workflow-review delivery seam. The closure runs at workflow-fire time
  // (post-boot), so it safely references the mailbox bindings declared later in
  // this module. Enqueues the review prompt as a durable mailbox message.
  deliverWorkflowReview: deliverWorkflowReview,
  // Failed-run notification seam (workflow-engine redesign). Notifies the human
  // inbox + the project orchestrator when a run fails.
  deliverWorkflowRunFailed: deliverWorkflowRunFailed,
});
projectRegistry.loadAll();

const projectCreate = new ProjectCreate(projectScaffold, projectRegistry);

// Multiplexed channel server on :8788. Per-project channel-stdio children
// register via WS; external webhooks POST /channel/<slug>/<source>; we route
// to the matching child + emit a UI broadcast tagged with projectId.
const channelServer = new ChannelServer({
  port: CHANNEL_PORT,
  allowedSenders: new Set((process.env.CHANNEL_ALLOWED_SENDERS ?? 'test').split(',').filter(Boolean)),
  onEvent: (projectId, event) => {
    broadcastTo(projectId, { type: 'channel-event', projectId, event });
  },
  // 017 Phase C — external webhooks route unconditionally to the mailbox.
  webhookSink: deliverWebhookToMailbox,
});
channelServer.start();

// Section 18.8 — JSONL retention sweep at boot. Fire-and-forget so a slow
// or failing sweep can't block startup. Reads `jsonl.retentionDays` from
// the current settings envelope (default 30 days, `'never'` opts out).
{
  const retention = readSettings().jsonl.retentionDays;
  void sweepStaleJsonl({ retention })
    .then((result) => {
      if (retention === 'never') {
        console.log('[pc] jsonl-sweep skipped (retention=never)');
        return;
      }
      console.log(
        `[pc] jsonl-sweep: scanned ${result.scanned}, deleted ${result.deleted}, skipped ${result.skipped}, freed ${result.bytesFreed} bytes (retention=${retention}d)`,
      );
    })
    .catch((err) => {
      console.warn(`[pc] jsonl-sweep failed: ${(err as Error).message}`);
    });
}

// Section 27.3 — one-time stage-flag backfill. Idempotent: skips projects
// whose stages already carry any flag. Tags is_new on stages[0] of untouched
// projects, plus is_done on a single "Done"-named stage if exactly one
// matches (case-insensitive).
{
  try {
    const result = backfillStageFlags();
    if (result.updated > 0) {
      console.log(
        `[pc] stage-flags-backfill: scanned ${result.scanned}, updated ${result.updated}, skipped ${result.skipped}`,
      );
    }
  } catch (err) {
    console.warn(`[pc] stage-flags-backfill failed: ${(err as Error).message}`);
  }
}


// ── Slice 009 — mailbox value bindings RELOCATED above the boot handlers ──
// The boot-reattach / reconcile-sweep / liveness-sweep handlers below apply
// host terminals and must carry the agent delivery gate + mailbox port. They
// run AT boot (the reattach is an inline await that can apply a terminal
// synchronously), so a lazy reference to these bindings would hit the const
// TDZ. Constructing them here (before :369) removes the hazard. The mailbox
// ROUTES + worker setInterval + boot sweeps stay at their original sites; only
// these six value bindings moved up. All closed-over values are available here:
// broadcastTo, broadcastSendQueueSnapshot,
// parseMailboxAddress (imported), getMailboxMessage/
// getMailboxRecipient (imported), resolveProject (hoisted fn :466, called only
// at delivery time inside these closures).
const mailboxService = new MailboxService();

// Mailbox `orchestrator-turn` delivery: a ConversationSendService whose deps
// dispatch by projectId through the project registry. Only `enqueueRuntimeTurn`
// is exercised by the worker (never a raw send; the queue drains the row).
const mailboxSendService = new ConversationSendService({
  getPort: (projectId) => resolveProject(projectId)?.ptySession() ?? null,
  ensurePort: (projectId) => {
    const runtime = resolveProject(projectId);
    if (!runtime) throw new Error(`unknown project: ${projectId}`);
    return runtime.ensurePty();
  },
  ensureActiveSession: (projectId) => {
    const runtime = resolveProject(projectId);
    if (!runtime) throw new Error(`unknown project: ${projectId}`);
    return runtime.ensureActiveSession();
  },
  broadcastSendQueueSnapshot,
});
const mailboxOrchestratorTurnAdapter = new MailboxOrchestratorTurnAdapter(mailboxSendService);

const mailboxWorker = new MailboxWorker({
  service: mailboxService,
  orchestratorTurn: mailboxOrchestratorTurnAdapter,
  // Slice 015b — delivery frames ride the relay (outbox row written in the
  // service txn); no hand-fanout. `broadcast`/`getMessageProjectId` removed.
  getRecipientAddress: (recipientId) => {
    const row = getMailboxRecipient(recipientId);
    if (!row) return null;
    const parsed = parseMailboxAddress(row.addressJson);
    return parsed.ok ? parsed.value : null;
  },
  getMessageBody: (messageId) => getMailboxMessage(messageId)?.body ?? null,
});

// Slice 015b — the enqueue writes the canonical `mailbox.message.changed`
// outbox row inside its txn; the relay delivers it. No hand-fanout. (Name kept
// for the delivery-router cutover call sites; it is now a thin enqueue.)
function enqueueMailboxAndFanout(input: EnqueueMailboxMessageInput): MailboxEnqueuePublication {
  return mailboxService.enqueue(input);
}

// Boot-time agent-run reconciliation. T1.2 (D1) — boot reattach now consumes the
// ONE `hostConnection`: refresh its run cache FIRST (it connects lazily + the
// sync reattach enumeration reads `listRuns()`), then pass `getHostClient: () =>
// hostConnection` so reattach's persistent `onEvent` rides the shared multiplexed
// emitter (truly one stream). `mode === 'host'` is the host-mode discriminator.
{
  try {
    // S1 — refreshRuns() on an unreachable host returns an EMPTY cache (the
    // throw is swallowed inside ensureConnected), so a boot reattach against
    // that empty list would mark every live run host-lost. Only reconcile when
    // the host was actually reached this boot; otherwise stay host-mode and let
    // the continuous sweep (which has the hostAuthoritativelyAbsent +
    // consecutive-tick guard) converge safely.
    let refreshOk = true;
    await hostConnection.refreshRuns().catch(() => {
      refreshOk = false;
    });
    const hostReached = refreshOk && hostConnection.isConnected();
    const result = hostReached
      ? await reattachAgentRunsDuringServerBoot({
          getHostClient: () => hostConnection,
          broadcast: broadcastTo,
          mailboxEnqueue: enqueueMailboxAndFanout,
        })
      : null;
    if (!result) {
      // Host expected but not reachable this boot — skip the destructive
      // reconcile. The sweep converges once the host comes back; dispatch
      // self-heals on reconnect. The UI surfaces it via the host-health banner.
      hostMode = true;
      console.warn(
        '[agent-host] boot: host not reachable; skipped boot reconcile (sweep will converge), dispatch will retry on reconnect',
      );
    } else if (result.mode === 'host') {
      hostMode = true;
      const reattach = result.reattach;
      const changed =
        reattach.reconcile.reconciled +
        reattach.registered +
        reattach.backfilledEvents +
        reattach.terminalReplayed;
      if (changed > 0) {
        console.log(
          `[agent-runs] host boot reattach: registered=${reattach.registered}, backfilled=${reattach.backfilledEvents}, terminal=${reattach.terminalReplayed}, reconciled=${reattach.reconcile.reconciled}`,
        );
      }
    } else if (result.reconcile.reconciled > 0) {
      console.log(
        `[agent-runs] reconciled ${result.reconcile.reconciled} agent run row(s) on boot (${result.reconcile.mode})`,
      );
    }
  } catch (err) {
    console.error('[agent-runs] boot reattach failed:', (err as Error).message);
  }
}

// Slice 017 Fix 4 — workflow-run boot reconciliation (slice 004 was imported
// but never invoked). Mirrors the agent-run boot reconcile above: interrupted
// `running`/`pending` runs fail-closed with `interrupted-on-boot` + a durable
// `workflow.run.changed` (reason:'reconciled') fact; `paused` runs are skipped.
{
  try {
    const workflowRunGateway = new WorkflowRunMutationGateway();
    const wfResult = reconcileWorkflowRunsOnBoot({
      listRuns: () => workflowRunsV2Repo.listRunsByStatus(RECONCILE_SCAN_STATUSES),
      failClosed: (run, reason) => {
        workflowRunGateway.commitRunChange({
          projectId: run.projectId,
          reason: 'reconciled',
          mutate: () => {
            workflowRunsV2Repo.setStatus(run.id, 'failed', { lastReason: reason });
            return workflowRunsV2Repo.getRun(run.id);
          },
        });
      },
    });
    if (wfResult.failed > 0) {
      console.log(
        `[workflow-runs] boot reconcile: failed-closed=${wfResult.failed}, skippedPaused=${wfResult.skippedPaused}, scanned=${wfResult.scanned}`,
      );
    }
  } catch (err) {
    console.error('[workflow-runs] boot reconcile failed:', (err as Error).message);
  }
}

// T2.2 — ONE mode-agnostic agent-run watchdog (folds the prior reconcile +
// liveness sweeps). State-propagation Step 1 (docs/state-propagation-decision.md):
// events = latency, reconcile = correctness. Per tick, in order:
//   1. host-mode: refresh host snapshots through the ONE self-healing
//      `hostConnection` (picks up a respawned host on a new port, no API
//      restart) + reconcile non-terminal rows — a terminal transition the live
//      stream dropped still converges here (full effects: DB flip + orchestrator
//      notify + rail broadcast). T1.4: a non-terminal row absent from the host
//      for >= PC_HOST_LOST_TICKS consecutive ticks (and the connection
//      authoritatively unreachable this tick) is finalized terminal `host-lost`,
//      so a dead host no longer leaves runs stuck "running" forever.
//   2. in-process mode: liveness kill — pid-dead → `unexpected-exit`; idle past
//      KILL_MS → kill + `idle-timeout`. Runs BEFORE stall-warn so a just-killed
//      row is already terminal and skipped below.
//   3. BOTH modes: stall-warn — a run quiet past WARN_MS gets a visible,
//      non-terminal `stalled` badge (the intermediate state). Stall-warn stays
//      the intermediate signal in both modes; T1.4 adds the host-mode TERMINAL
//      path above (host-mode is no longer warn-only).
const AGENT_RUN_WATCHDOG_MS = 15_000;
const watchdogStalledRuns = new Set<string>();
// T1.4 — consecutive ticks each host-mode run has been missing from the host's
// list-runs. Owned here (persists across sweeps); reconcile resets it when a row
// reappears or finalizes. The threshold is the false-positive guard.
const hostMissingTicks = new Map<string, number>();
const HOST_LOST_TICKS = (() => {
  const raw = Number(process.env.PC_HOST_LOST_TICKS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
})();
const agentRunWatchdogSweep = setInterval(() => {
  void (async () => {
    try {
      if (hostMode) {
        // T1.4 — only run the host-lost finalize when refreshRuns COMPLETED. A
        // thrown refresh is the transient case: skip the finalize AND do not
        // increment counters.
        let refreshed = true;
        try {
          await hostConnection.refreshRuns();
        } catch {
          refreshed = false;
        }
        const res = reconcileAgentRunsAgainstHost({
          hostClient: hostConnection,
          activeRunRegistry: getActiveRunRegistry(),
          broadcast: broadcastTo,
          mailboxEnqueue: enqueueMailboxAndFanout,
          // hasOpenPendingAskForRun defaults to the real @pc/db repo inside the
          // reconcile (the paused-with-open-ask guard) — no need to thread it.
          // Authoritative absence = we are CONNECTED to a host whose fresh
          // list-runs we just refreshed (so `listRuns()` is the live inner list,
          // not the stale `lastRuns` cache that disconnected returns) AND the run
          // is absent from it. After a dev-supervisor respawn the new host has no
          // memory of pre-respawn runs, so a still-`running` row missing from its
          // list for HOST_LOST_TICKS ticks is genuinely lost. The reconcile gates
          // finalize on `status==='running'`, so a slow-spawning/queued run that
          // legitimately isn't listed yet is never false-killed.
          hostAuthoritativelyAbsent: refreshed && hostConnection.isConnected(),
          missingFromHostTicks: refreshed ? hostMissingTicks : undefined,
          hostLostAfterTicks: HOST_LOST_TICKS,
        });
        if (res.terminalApplied > 0 || res.statusUpdated > 0 || res.hostLost > 0) {
          console.log(
            `[agent-runs] reconcile: terminal=${res.terminalApplied}, status=${res.statusUpdated}, hostLost=${res.hostLost}, checked=${res.checked}`,
          );
        }
      } else {
        const res = sweepAgentRunLiveness({
          activeRunRegistry: getActiveRunRegistry(),
          broadcast: broadcastTo,
          mailboxEnqueue: enqueueMailboxAndFanout,
        });
        if (res.failedDead > 0 || res.failedIdle > 0) {
          console.log(
            `[agent-runs] liveness: dead=${res.failedDead}, idle=${res.failedIdle}, killed=${res.killed}, checked=${res.checked}`,
          );
        }
      }

      const warn = sweepStallWarn({
        stalledRuns: watchdogStalledRuns,
        broadcast: broadcastTo,
      });
      if (warn.warned > 0 || warn.cleared > 0) {
        console.log(`[agent-runs] stall-warn: warned=${warn.warned}, cleared=${warn.cleared}`);
      }
    } catch (err) {
      console.warn('[agent-runs] watchdog sweep failed:', (err as Error).message);
    }
  })();
}, AGENT_RUN_WATCHDOG_MS);
// Don't let the sweep timer keep the process alive on shutdown.
if (typeof agentRunWatchdogSweep.unref === 'function') agentRunWatchdogSweep.unref();

const app = new Hono();

/** Holds resolvers for in-flight AskUserQuestion / ExitPlanMode calls. */
const pendingAsks = createPendingAskStore();

// ── Helpers ───────────────────────────────────────────────────────────────

/** Look up the runtime for `projectId`. Returns null if unknown. */
function resolveProject(projectId: string): ProjectRuntime | null {
  return projectRegistry.ensure(projectId as ULID);
}

registerMcpBridgeRoutes(app, {
  dataDir: DATA,
  resolveProject,
  getHostClient: () => hostConnection,
});

// ── Slice 007 — mailbox platform (additive; alongside Channel, no cutover) ──
// NOTE (slice 009): the mailbox VALUE bindings (mailboxService,
// mailboxSendService, mailboxOrchestratorTurnAdapter, mailboxWorker,
// deliveryRouter, enqueueMailboxAndFanout) were RELOCATED above the boot
// handlers (~:366) so the boot-reattach/reconcile/liveness handlers can carry
// the agent delivery gate without a const TDZ. The routes + worker setInterval
// stay here.
const pendingInteractionService = new PendingInteractionService();
const askShadow = new AskShadow({ interactions: pendingInteractionService });

registerChatBridgeRoutes(app, {
  broadcastTo,
  pendingAsks,
  resolveProject,
  channelPort: CHANNEL_PORT,
  askShadow,
});

registerMailboxRoutes(app, {
  mailbox: mailboxService,
  interactions: pendingInteractionService,
  // Mailbox-message AND pending-interaction delivery ride the relay (015b);
  // no fanout deps.
});

// Workflow-review delivery. Hoisted so the ProjectRegistry built at boot can
// reference it; the body runs at workflow-fire time so the const bindings above
// are initialised by then. Enqueues the review prompt as a durable mailbox
// message (active-orchestrator + orchestrator-turn).
function deliverWorkflowReview(input: {
  projectId: ULID;
  runId: ULID;
  nodeId: string;
  flavor: 'human' | 'orchestrator';
  body: string;
}): boolean {
  enqueueMailboxAndFanout({
    message: {
      id: newId(),
      projectId: input.projectId,
      kind: 'workflow-review',
      body: input.body,
      sourceKind: 'workflow-run-node',
      sourceId: `${input.runId}:${input.nodeId}`,
      idempotencyKey: `workflow-review:${input.runId}:${input.nodeId}`,
    },
    recipients: [
      {
        id: newId(),
        addressKind: 'active-orchestrator',
        addressJson: { kind: 'active-orchestrator', projectId: input.projectId },
        channel: 'orchestrator-turn',
        deliveryId: newId(),
      },
    ],
    now: Date.now(),
  });
  return true;
}

// Workflow-engine redesign — failed-run notification. Hoisted (referenced by the
// ProjectRegistry built at boot; the body runs at run-finalize time). Enqueues
// ONE durable `workflow-run-failed` message with TWO recipients: the human
// user-inbox (ui-inbox) AND the project orchestrator (active-orchestrator,
// orchestrator-turn). If no orchestrator is live the orchestrator delivery
// persists and drains on its next liveness pass — the run failure is never lost.
function deliverWorkflowRunFailed(input: {
  projectId: ULID;
  runId: ULID;
  workflowName: string;
  workItemId: ULID | null;
  reason: string;
}): void {
  const body =
    `Workflow "${input.workflowName}" failed.\n\n` +
    `Reason: ${input.reason}\n` +
    `Run: ${input.runId}` +
    (input.workItemId ? `\nCard: ${input.workItemId}` : '');
  enqueueMailboxAndFanout({
    message: {
      id: newId(),
      projectId: input.projectId,
      kind: 'workflow-run-failed',
      subject: `Workflow failed: ${input.workflowName}`,
      body,
      payload: {
        runId: input.runId,
        workflowName: input.workflowName,
        workItemId: input.workItemId,
        reason: input.reason,
      },
      sourceKind: 'workflow-run',
      sourceId: input.runId,
      idempotencyKey: `workflow-run-failed:${input.runId}`,
    },
    recipients: [
      {
        id: newId(),
        addressKind: 'user-inbox',
        addressJson: { kind: 'user-inbox', userId: 'local-user', projectId: input.projectId },
        channel: 'ui-inbox',
        deliveryId: newId(),
      },
      {
        id: newId(),
        addressKind: 'active-orchestrator',
        addressJson: { kind: 'active-orchestrator', projectId: input.projectId },
        channel: 'orchestrator-turn',
        deliveryId: newId(),
      },
    ],
    now: Date.now(),
  });
}

// Flow C — external-webhook cutover sink. Hoisted so the ChannelServer built at
// boot can reference it. When the gate = `channel` (default) it returns false →
// the unchanged fan-to-children path runs. When `mailbox`, the event lands
// durably in the project inbox (ui-inbox; no silent drop on a missing
// registrant). Idempotency is best-effort: external `/channel` bodies carry no
// event id, so we hash slug+source+body and include the arrival timestamp.
function deliverWebhookToMailbox(event: ChannelEvent): boolean {
  const hash = createHash('sha256')
    .update(`${event.slug}|${event.source}|${event.body}`)
    .digest('hex')
    .slice(0, 16);
  enqueueMailboxAndFanout({
    message: {
      id: newId(),
      projectId: event.projectId,
      kind: 'external-webhook',
      subject: `${event.source} webhook`,
      body: event.body,
      payload: { slug: event.slug, source: event.source, sender: event.sender, at: event.at },
      sourceKind: 'external-webhook',
      sourceId: event.source,
      idempotencyKey: `webhook:${event.slug}:${event.source}:${hash}:${String(event.at)}`,
    },
    recipients: [
      {
        id: newId(),
        addressKind: 'project-inbox',
        addressJson: { kind: 'project-inbox', projectId: event.projectId },
        channel: 'ui-inbox',
        deliveryId: newId(),
      },
    ],
    now: Date.now(),
  });
  return true;
}

// Lease-driven delivery drain. Single in-process worker; the lease keeps the
// model restart-safe. Unref'd so it never blocks shutdown.
const MAILBOX_WORKER_SWEEP_MS = 1000;
const mailboxWorkerSweep = setInterval(() => {
  try {
    mailboxWorker.runOnce();
  } catch (err) {
    console.warn('[mailbox] worker pass failed:', (err as Error).message);
  }
}, MAILBOX_WORKER_SWEEP_MS);
if (typeof mailboxWorkerSweep.unref === 'function') mailboxWorkerSweep.unref();

// Slice 015a — universal post-commit relay drain. Gateways write the outbox row
// in-txn; this short-interval drain fans the committed rows to subscribers
// regardless of which subsystem wrote them, so 015a delivers via the relay for
// EVERY domain without yet touching any call site (dual delivery beside the
// existing fanout). 015b replaces this blanket timer with explicit post-commit
// drains as each subsystem's hand-fanout is deleted. Unref'd; never blocks
// shutdown. Drain is re-entrant-safe and a no-op when there's nothing new.
const LIVE_RELAY_DRAIN_MS = 250;
const liveRelayDrainSweep = setInterval(() => {
  try {
    liveRelay.drain();
  } catch (err) {
    console.warn('[live-relay] drain pass failed:', (err as Error).message);
  }
}, LIVE_RELAY_DRAIN_MS);
if (typeof liveRelayDrainSweep.unref === 'function') liveRelayDrainSweep.unref();

// Slice 015a — outbox prune by size AND age (whichever hits first). The outbox
// is a transient delivery buffer, not an event store; prune by fixed size/age,
// never by a live-cursor watermark. A reconnecting client whose cursor predates
// the new floor self-heals via the `resetRequired` → full-domain-reload path.
const LIVE_OUTBOX_MAX_ROWS = 10_000;
const LIVE_OUTBOX_MAX_AGE_MS = 60 * 60 * 1000; // 1h
const LIVE_OUTBOX_PRUNE_MS = 5 * 60 * 1000; // every 5m
function pruneLiveOutboxSafe(): void {
  try {
    const result = pruneLiveOutbox({
      maxRows: LIVE_OUTBOX_MAX_ROWS,
      maxAgeMs: LIVE_OUTBOX_MAX_AGE_MS,
    });
    if (result.deleted > 0) {
      console.log(`[live-relay] pruned ${result.deleted} outbox row(s); floor=${result.floor}`);
    }
  } catch (err) {
    console.warn('[live-relay] outbox prune failed:', (err as Error).message);
  }
}
pruneLiveOutboxSafe();
const liveOutboxPruneSweep = setInterval(pruneLiveOutboxSafe, LIVE_OUTBOX_PRUNE_MS);
if (typeof liveOutboxPruneSweep.unref === 'function') liveOutboxPruneSweep.unref();

// Boot-sweep orphaned `open` ask-shadow rows to `expired` (a lost /api/ask
// connection cannot be unblocked). Inspectable, not a resume.
{
  try {
    const swept = sweepOrphanedPendingInteractions();
    if (swept > 0) console.log(`[mailbox] swept ${swept} orphaned pending interaction(s) to expired`);
  } catch (err) {
    console.warn('[mailbox] pending-interaction boot sweep failed:', (err as Error).message);
  }
}

/**
 * Listens on the `jsonl-event` channel for the first `jsonl-user` envelope of
 * a session and derives a title from its text. Idempotent once a title is set
 * — every subsequent `jsonl-user` is a no-op until `ai-title` (which doesn't
 * fire under `--agent`) overwrites.
 *
 * Wiring history:
 *   - pre-Section-23: read from PtySession's `event` channel (hook-driven user
 *     events). Hooks stopped emitting user events when 23 made JSONL canonical.
 *   - Section 31.9: deferred to CC's `ai-title` envelope. Worked only for
 *     non-`--agent` spawns — i.e. NOT the orchestrator or any PM pod.
 *   - Current: consumes the tailer's `jsonl-user` envelope. Same heuristic,
 *     live channel.
 *
 * Uses `session-title-updated` (NOT `session-changed`): the client treats
 * `session-changed` as a hard checkpoint that wipes the chat event buffer
 * (correct for new-session / resume — claude.exe context just changed).
 * A title-only metadata update must NOT wipe — would blank the chat panel
 * mid-conversation. Burned: tool calls right after the first user prompt
 * caused chat to "go blank" until refresh, because title-set fired
 * session-changed and the buffer reset just as tool events were landing.
 */
function maybeSetSessionTitle(projectId: ULID, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const ev = event as { kind?: string; text?: string };
  if (ev.kind !== 'jsonl-user' || typeof ev.text !== 'string') return;
  const active = getActiveOrchestratorSession(projectId);
  if (!active || active.title) return;
  const title = deriveTitleFromText(ev.text);
  if (!title) return;
  setOrchestratorSessionTitle(active.id, title);
  const updated = getActiveOrchestratorSession(projectId);
  // Slice 015b — announce through the durable door; the relay delivers the
  // canonical session.title.changed frame. No hand-fanout.
  if (updated) announceSessionTitle(projectId, updated);
}

/** Section 31.9 — bind the rail session row title + chat title bar to CC's
 *  `ai-title`. Fires repeatedly through the session as CC refines the title;
 *  every update overwrites the persisted value + broadcasts.
 *  Replaces the pre-31.9 first-user-prompt heuristic (`maybeSetSessionTitle`
 *  stays in place as a fallback for sessions that never get an ai-title —
 *  e.g. very short sessions, or pre-31.9 historical rows).
 */
function maybeApplyAiTitle(projectId: ULID, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const ev = event as { kind?: string; title?: string };
  if (ev.kind !== 'jsonl-ai-title' || typeof ev.title !== 'string') return;
  const title = ev.title.trim();
  if (!title) return;
  const active = getActiveOrchestratorSession(projectId);
  if (!active) return;
  if (active.title === title) return;
  setOrchestratorSessionTitle(active.id, title);
  const updated = getActiveOrchestratorSession(projectId);
  // Slice 015b — announce through the durable door; the relay delivers the
  // canonical session.title.changed frame. No hand-fanout.
  if (updated) announceSessionTitle(projectId, updated);
}

/** First non-empty line, collapsed whitespace, truncated to ~60 chars. Skips
 *  CC's `<local-command-caveat>` / `<command-name>` / `<command-message>` /
 *  `<command-args>` wrapper lines so titles capture the user's actual prompt
 *  rather than the meta envelope. */
function deriveTitleFromText(text: string): string {
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('<')) continue;
    const collapsed = line.replace(/\s+/g, ' ').trim();
    if (!collapsed) continue;
    return collapsed.length <= 60 ? collapsed : collapsed.slice(0, 57).trimEnd() + '…';
  }
  return '';
}

/**
 * Section 31.12 — persist CC's `system:post_turn_summary` JSONL events to the
 * DB. Idempotent by (projectId, summarizes_uuid); replay won't double-write.
 *
 * SessionId comes from the raw entry — CC always tags JSONL rows with their
 * owning session uuid. Best-effort: if a row arrives without it (legacy
 * shape), we still log with sessionId=null rather than dropping the data.
 */
function maybePersistPostTurnSummary(projectId: ULID, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const ev = event as {
    kind?: string;
    summarizesUuid?: string | null;
    statusCategory?: string | null;
    statusDetail?: string | null;
    isNoteworthy?: boolean;
    title?: string | null;
    description?: string | null;
    recentAction?: string | null;
    needsAction?: boolean;
    artifactUrls?: unknown;
    timestamp?: string | null;
    raw?: unknown;
  };
  if (ev.kind !== 'jsonl-post-turn-summary') return;
  const raw = (ev.raw ?? {}) as { sessionId?: unknown };
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : null;
  try {
    insertPostTurnSummary({
      id: newId(),
      projectId,
      sessionId,
      summarizesUuid: ev.summarizesUuid ?? null,
      statusCategory: ev.statusCategory ?? null,
      statusDetail: ev.statusDetail ?? null,
      isNoteworthy: ev.isNoteworthy === true,
      title: ev.title ?? null,
      description: ev.description ?? null,
      recentAction: ev.recentAction ?? null,
      needsAction: ev.needsAction === true,
      artifactUrls: ev.artifactUrls ?? null,
      timestamp: ev.timestamp ?? null,
      createdAt: Date.now(),
      raw: ev.raw ?? null,
    });
  } catch (err) {
    console.error(
      '[pc] insertPostTurnSummary failed:',
      (err as Error).message,
    );
  }
}

// ── Global settings (Q10 envelope) ────────────────────────────────────────

registerSettingsOnboardingRoutes(app);

registerFileRoutes(app, {
  projectFolderPath: (projectId) => getProjectById(projectId)?.folderPath ?? null,
});

registerProjectRoutes(app, {
  createProject: (input) => projectCreate.create(input),
  refreshProject: (project) => projectRegistry.refresh(project as unknown as Project),
  removeProject: (projectId) => projectRegistry.remove(projectId),
  resolveProject,
  publishProjectChanged: (_legacyEvent, _liveEvent) => {
    // Slice 015c — fully relay-delivered. The mutation gateways write the
    // global-scope `project.changed` outbox row in-txn (`projects.ts`
    // `projectChanged(...)`); the relay's global `broadcastAll` fans the
    // canonical frame to every socket on its drain tick, which the web's
    // project-changed scanner already treats as a refetch trigger. Both the
    // hand frame-fanout (015b) AND the legacy refetch envelope (here) are gone.
  },
});

registerLiveEventRoutes(app);

// T2.3 — current-state seed for the global host-health pill/banner. The replay
// route is catch-up-from-cursor (empty without a prior cursor), so a cold page
// load can't seed the pill from it. This returns the latest host-health frame
// (already a fully-formed live-event) so the client seeds the store on load.
app.get('/api/agent-host/health', (c) =>
  c.json({ ok: true, event: getLatestLiveEventForEntity('host-health') }),
);

// Section 17d.1 — Pod (DB-resident agent) routes. Pods are global-scope in
// v1; v2 (17c) overlays project rows.
//
// 17d.10 — `onPodChanged` triggers restart-on-edit for the orchestrator
// pod across every loaded ProjectRuntime. Worker pods (researcher, etc.)
// are intentionally NOT restarted — killing them mid-task would orphan
// their work, and the next dispatch re-reads the DB anyway.
/** Section 19.17 — workflows are first-class scoped rows (mirrors agents
 *  pattern). CRUD + lifecycle live under `/api/workflows/*`; the legacy
 *  `/api/projects/:projectId/workflow-v2/*` GET endpoints survive only as
 *  read-only compat for the existing web client (19.18 rewires). */
registerWorkflowRoutes(app, {
  countInFlightRuns: (projectId, slug) => {
    const runs = workflowRunsV2Repo.listRunsByProject(projectId);
    return runs.filter(
      (r) =>
        r.workflowId === slug &&
        (r.status === 'pending' || r.status === 'running' || r.status === 'paused'),
    ).length;
  },
  cancelInFlightRuns: (projectId, slug) => {
    const runs = workflowRunsV2Repo.listRunsByProject(projectId);
    for (const r of runs) {
      if (
        r.workflowId === slug &&
        (r.status === 'pending' || r.status === 'running' || r.status === 'paused')
      ) {
        // Write-door: writeRunStatus increments rev + reads back full row
        // + broadcasts a versioned full-snapshot delta.
        writeRunStatus(
          r.id,
          'cancelled',
          { lastReason: 'workflow soft-deleted' },
          projectId,
          (ev) => broadcastTo(projectId, ev),
        );
      }
    }
  },
  fireWorkflow: async (projectId, def, trigger) => {
    const runtime = resolveProject(projectId);
    if (!runtime) throw new Error(`unknown project: ${projectId}`);
    return runtime.fireV2Workflow(def, trigger);
  },
});

registerPodRoutes(app, {
  resetStockPodToDefault: (name, reason) => {
    const r = resetStockPodToDefault(name, reason);
    return { agent: r.agent, resetFields: r.resetFields };
  },
  detectStockPodDrift,
  listCanonicalStockPodNames,
  onPodChanged: (podName) => {
    if (podName !== 'orchestrator') return;
    for (const runtime of projectRegistry.list()) {
      const restarted = runtime.restartIfOrchestratorPod(podName);
      if (!restarted) continue;
      try {
        ensureOrchestratorPty(runtime.project.id, runtime);
        // No replayActiveSessionEvents — chat history already in the UI;
        // the user sees a brief reconnect blip + the next prompt-turn
        // reflects the new orchestrator identity.
      } catch (err) {
        console.error(
          `[pc] orchestrator restart-on-pod-edit failed for ${runtime.project.id}: ${(err as Error).message}`,
        );
      }
    }
  },
});

registerRuntimeHostRoutes(app, {
  resolveProject,
  runtimeSnapshotPayload: (projectId, runtime) => runtimeSnapshots.payload(projectId, runtime),
  broadcastTo,
  broadcastRuntimeSnapshot,
  broadcastSendQueueSnapshot,
  ensureOrchestratorPty,
  startOrchestratorPtyInBackground,
});

registerProjectContextRoutes(app, {
  resolveProject,
  getProjectFolderPath: (projectId) => getProjectById(projectId)?.folderPath ?? null,
});

registerProjectDetailRoute(app, { resolveProject });

registerTransientSessionRoutes<ReturnType<ProjectRuntime['startAgentDesigner']>, ProjectRuntime>(
  app,
  {
    resolveProject,
    broadcastTo,
  },
);

registerWorkItemRoutes(app, {
  resolveProject,
  broadcastTo,
  refreshProject: (project) => projectRegistry.refresh(project),
  mailboxEnqueue: enqueueMailboxAndFanout,
  getHostConnection: () => hostConnection,
});

registerAreaRoutes(app, { resolveProject });

registerContractRoutes(app, {});

registerWorkflowCompatRoutes(app, { resolveProject, broadcastTo });

registerWorktreeRoutes(app, { resolveProject });

// 19.12 — v1 /workflow/node-complete, /workflow/node-failed, /approvals
// routes removed. v2 DAG handles node completion + approvals internally;
// review responses go through POST /workflow-v2/review.

registerAgentRunRoutes(app, {
  broadcastTo,
  getHostConnection: () => hostConnection,
  // Agent delivery enqueues + fans out the mailbox message frame (the worker
  // then drains delivery + fans delivery frames) — the sole delivery door.
  mailboxEnqueue: enqueueMailboxAndFanout,
});

registerStatuslineRoutes(app, { broadcastTo });

registerDevControlRoutes(app, { gracefulShutdown });

// ── Static / SPA fallback ─────────────────────────────────────────────────

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function staticMime(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return STATIC_MIME[filePath.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

app.get('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return next();

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = resolve(PUBLIC, '.' + requested);
  // Section 22.7 — `startsWith(PUBLIC)` is unsafe across sibling-prefix
  // paths (a sibling directory "dist-evil" would match the "dist" prefix).
  // `path.relative` containment rejects '..' walks AND sibling prefixes.
  const rel = relative(PUBLIC, filePath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    // Empty `rel` means filePath === PUBLIC — treat as "no file" not as the
    // public dir itself.
    if (rel !== '') return c.text('Forbidden', 403);
  }

  try {
    const s = await stat(filePath);
    if (s.isFile()) {
      const content = await readFile(filePath);
      return new Response(new Uint8Array(content), {
        headers: { 'Content-Type': staticMime(filePath) },
      });
    }
  } catch {
    /* fall through to SPA index */
  }

  try {
    const html = await readFile(resolve(PUBLIC, 'index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text(
      'apps/web build not found. Run `pnpm --filter @pc/web build` (or use dev mode on :5173).\n',
      503,
    );
  }
});

const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`[pc] http://127.0.0.1:${info.port}`);
});

const wss = registerRuntimeHostWebSocketServer<ReturnType<ProjectRuntime['ensurePty']>, ProjectRuntime>({
  server,
  path: '/ws',
  wsHub,
  resolveProject,
  attachPtyHandlers,
  runtimeSnapshotPayload: (id, targetRuntime) => runtimeSnapshots.payload(id, targetRuntime),
  startOrchestratorPtyInBackground,
  broadcastTo,
  broadcastSendQueueSnapshot,
  // Slice 015a — per-socket cursor catch-up. The relay replays the outbox window
  // `(lastVersion, snapshot]` to this socket on its `subscribe` handshake; live
  // rows then arrive via the hub subscription attached on connect.
  catchUp: (socket, lastVersion, projectId) =>
    liveRelay.catchUp(socket, lastVersion, projectId),
  ensureOrchestratorPty,
  resolvePendingAsk: (id, answer) => {
    const resolved = pendingAsks.resolve(id, answer);
    // Slice 007 — terminalize the durable ask-shadow `answered` (side write).
    if (resolved) askShadow.onResolved(id, answer);
  },
});

function gracefulShutdown(): void {
  clearInterval(agentRunWatchdogSweep);
  clearInterval(mailboxWorkerSweep);
  clearInterval(liveRelayDrainSweep);
  clearInterval(liveOutboxPruneSweep);
  // Send clean close frames (1001 "going away") to every live WS client so
  // browsers observe the close and reconnect immediately instead of waiting
  // out the heartbeat timeout. Best-effort: don't hang shutdown on any one
  // socket. wss.close() stops accepting new connections.
  for (const client of wss.clients) {
    try { client.close(1001, 'server going away'); } catch { /* best-effort */ }
  }
  try { wss.close(); } catch { /* best-effort */ }
  hostConnection.close();
  projectRegistry.shutdownAll();
  channelServer.shutdown();
}

process.on('SIGINT', () => {
  console.log('[pc] SIGINT — shutting down');
  gracefulShutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[pc] SIGTERM — shutting down');
  gracefulShutdown();
  process.exit(0);
});
