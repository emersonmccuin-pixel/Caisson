import './diagnostics.ts'; // FIRST — arm crash capture before anything else loads
import { initVaultFromStdin } from './services/secrets-vault.ts';
// Connector-auth Slice 1: read the vault master key from stdin (sent by Electron
// main via a private pipe) before any other module uses the vault. No-ops when
// PC_VAULT_USE_STDIN is not set (dev mode, tests).
initVaultFromStdin();

import { serve } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse as NodeServerResponse } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';

import { SERVER_ROOT } from './server-root.ts';

import type {
  Project,
  ULID,
  WorkflowV2,
} from '@pc/domain';
import { parseMailboxAddress } from '@pc/contracts';
import {
  getActiveOrchestratorSession,
  getLatestLiveEventForEntity,
  getAgentRunRow,
  getMailboxMessage,
  getMailboxRecipient,
  insertPostTurnSummary,
  getProjectById,
  getProjectBySlug,
  listContractsPendingLanding,
  listNonTerminalAgentRuns,
  listProjects,
  listWorkItems,
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
  reconcileWorkflowRunsOnBoot,
  RECONCILE_SCAN_STATUSES,
  WORKFLOW_INTERRUPTED_ON_BOOT_REASON,
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
import { createWorktreeSweepRunner } from './services/worktree-sweep-runner.ts';
import { landAcceptedContract, setLandingWorktreesAccessor } from './services/landing-service.ts';
import { backfillStageFlags } from './services/stage-flags-backfill.ts';
import { seedClaudeFirstRun } from './services/claude-firstrun-seed.ts';
import { ProjectCreate } from './services/project-create.ts';
import { ProjectRegistry } from './services/project-registry.ts';
import type { ProjectRuntime } from './services/project-runtime.ts';
import { ProjectScaffold } from './services/project-scaffold.ts';
import { registerFileRoutes } from './features/files/routes.ts';
import {
  destroyWorktree as _destroyWorktreeForCleanup,
  pruneWorktrees as _pruneWorktreesForCleanup,
  resolveClaudeBinary,
  setBundledClaudeExe,
} from '@pc/runtime';
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
import { registerWorkItemRoutes } from './features/work-items/routes.ts';
import { registerAreaRoutes } from './features/areas/routes.ts';
import { registerFocusRoutes } from './features/focus/routes.ts';
import { registerContextDocRoutes } from './features/context-docs/routes.ts';
import { registerContractRoutes } from './features/contracts/routes.ts';
import { registerAgentRunRoutes } from './features/agent-runs/routes.ts';
import { registerWorktreeRoutes } from './features/project-worktrees/routes.ts';
import { registerStatuslineRoutes } from './features/statusline/routes.ts';
import { registerLiveEventRoutes } from './features/live-events/routes.ts';
import { registerDevControlRoutes } from './features/dev-controls/routes.ts';
import { registerProjectContextRoutes } from './features/project-context/routes.ts';
import { registerWorkflowCompatRoutes } from './features/workflow-compat/routes.ts';
import {
  createMcpHandshakeRouter,
  registerMcpBridgeRoutes,
} from './features/mcp-bridge/routes.ts';
import { createPcRigHttpEndpoint } from '@pc/mcp/http-endpoint';
import { mcpAuthSecret, verifyMcpToken } from './services/mcp-http-auth.ts';
import {
  createPendingAskStore,
  registerChatBridgeRoutes,
} from './features/chat-bridges/routes.ts';
import { registerMailboxRoutes } from './features/mailbox/routes.ts';
import { registerPastedImageRoutes } from './features/pasted-images/routes.ts';
import { MailboxOrchestratorTurnAdapter } from './services/mailbox-orchestrator-turn-adapter.ts';
import { MailboxWorker } from './services/mailbox-worker.ts';
import { backfillConversationEvents } from './services/conversation-backfill.ts';
import {
  STALE_ASK_SWEEP_MS,
  sweepStalePendingAsks,
} from './services/pending-ask-watchdog.ts';
import {
  sweepWorkItemStallWarn,
  resolveWorkItemStallSweepMs,
} from './services/work-item-stall-warn.ts';
import { registerPodRoutes } from './routes/pod-routes.ts';
import { registerWorkflowRoutes } from './routes/workflow-routes.ts';
import { registerMcpServerRoutes } from './features/mcp-servers/routes.ts';
import { probeMcpServer } from '@pc/mcp/probe';
import { seedOrchestratorPodIfMissing } from './services/orchestrator-pod-seed.ts';
import { seedCommandPlannerPodIfMissing } from './services/command-planner-pod-seed.ts';
import { cleanupLegacyProjectRuntimeFiles } from './services/legacy-runtime-cleanup.ts';
import { resetStockPodToDefault } from './services/stock-pod-reset.ts';
import { detectStockPodDrift, listCanonicalStockPodNames } from './services/pod-drift.ts';
import { seedStockPods } from './services/stock-pod-seed.ts';
import { ensureCommandProject } from './services/command-seed.ts';
import { scrubDeadToolGrants } from './services/agent-tools-scrub.ts';
import { remapRenamedToolSlugs } from './services/tool-slug-remap.ts';
import { migrateStoredWorkflowDefsToV3 } from './services/workflow-def-migrate-v3.ts';
import { cancelWorkflowRunCascade } from './services/workflow-run-cancel.ts';
import { createAgentRunReconciler } from './services/agent-run-reconciler.ts';
import { getActiveRunRegistry } from './services/agent-active-runs.ts';
import { reHomeRunOnCurrentHost } from './services/agent-run-rehome.ts';
import {
  collectOpenChecklistCards,
  formatSweepBlock,
  sweepClientMessageId,
} from './services/session-open-checklist-sweep.ts';

// PUBLIC / TEMPLATES / the scaffold trunk path all derive from ROOT, so they
// relocate with it (PC_ROOT in packaged builds). server-root.ts is the ONE
// derivation — do not re-derive from import.meta.url anywhere else.
const ROOT = SERVER_ROOT;
const PUBLIC = resolve(ROOT, 'apps', 'web', 'dist');
// Section 22.3 — single runtime contract: every server-internal data path
// resolves through `getDataDir()` (`PC_DATA_DIR` env or workspace-root/data).
// The persisted `dataDir` settings field is cosmetic/informational; changing
// it is rejected at PATCH time and the GET always surfaces this value.
const DATA = getDataDir();
const TEMPLATES = resolve(ROOT, 'templates');

const PORT = Number(process.env.PORT ?? 4040);

// ROOT-relative so the staged `drizzle/` is found in a packaged build (where
// migrate.ts's __dirname points inside the bundle). Dev resolves to the trunk.
runMigrations(resolve(ROOT, 'packages', 'db', 'drizzle'));

// M3b — one-time import of per-session replay FILES (jsonl-events.jsonl /
// legacy events.jsonl) into conversation_events; files rename `*.imported`.
// Cheap once swept (an existsSync per session dir). Replay reads are DB-only.
backfillConversationEvents(DATA);

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

// Command planner pod — Command's chat (the global planning space). Seeded
// like the orchestrator; idempotent + drift-reseed on non-user-edited rows.
{
  const result = seedCommandPlannerPodIfMissing();
  switch (result.action) {
    case 'inserted':
      console.log(`[command] planner pod seeded (id=${result.agentId})`);
      break;
    case 'reseeded':
      console.log(
        `[command] planner pod auto-reseeded (id=${result.agentId}, fields=[${result.reseededFields.join(', ')}])`,
      );
      break;
    case 'skipped-user-edited':
      console.warn(
        `[command] planner pod drifted from COMMAND_PLANNER_POD_CONTENT on [${result.reseededFields.join(', ')}] but has user edits — leaving it alone.`,
      );
      break;
    case 'unchanged':
      break;
  }
}

// Migration 0055 — remap renamed knowledge-tool slugs in EVERY stored agent
// row (drift-reseed below only covers non-user-edited global stock pods;
// user-created + user-edited pods would otherwise keep dead slugs and their
// attached docs would go dark). Must run BEFORE seedStockPods so the
// user-edit detector sees already-normalized tool arrays. Idempotent.
{
  const res = remapRenamedToolSlugs();
  if (res.remapped > 0) {
    console.log(
      `[pc] 0055 tool-slug remap: rewrote knowledge→context-doc tool slugs on ${res.remapped}/${res.scanned} agents: ${res.rows.join(' · ')}`,
    );
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

// M7 (FD-6) — scrub dead tool grants (☠ pc_ask_user) from ALL stored agent
// rows; the stock reseed above only covers global stock pods. Idempotent.
{
  const res = scrubDeadToolGrants();
  if (res.scrubbed > 0) {
    console.log(
      `[pc] M7 dead-grant scrub: removed dead tool grants from ${res.scrubbed}/${res.scanned} agents: ${res.rows.join(' · ')}`,
    );
  }
}

// M6 — one-shot sweep: migrate stored workflow definitions to the v3 step
// model (strip triggers · move/loop steps). Idempotent; no-op once clean.
{
  const res = migrateStoredWorkflowDefsToV3();
  if (res.rewritten > 0) {
    console.log(
      `[pc] M6 def migration: rewrote ${res.rewritten}/${res.scanned} workflow defs to v3` +
        (res.nowInvalid.length ? ` (invalid for other reasons: ${res.nowInvalid.join(', ')})` : ''),
    );
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
  enqueueSessionOpenSweep: enqueueSessionOpenSweepForProject,
});

const projectScaffold = new ProjectScaffold({
  trunkPath: ROOT,
  templatesDir: TEMPLATES,
  dataDir: DATA,
  serverPort: PORT,
});

// T1.1 — the one long-lived HostConnection for the DISPATCH path. Lock-file is
// the sole source of host identity; `sendCommand` re-discovers + reconnects on a
// dead baseUrl, so a host respawn on a new port is picked up with NO API restart
// (kills T1-A). T1.2 — ALL live host consumers (sweep, mcp-bridge, ProjectRegistry
// → factory/spawner, boot reattach) now ride this ONE conduit + its multiplexed
// event stream; the frozen per-boot client is gone. Health transitions write the
// durable global `host-health` live-event consumed by the UI pill.
const hostConnection = createHostConnection({ dataDir: DATA });
hostConnection.onHealthChange((h) => announceHostHealth(toHostHealthSnapshot(h)));

// FD-15 — push the stored agent concurrency cap to the host. The host boots
// with its built-in default (it has no DB access); the SERVER owns the setting,
// so it re-pushes on every connect (covers host respawn) and on settings PATCH.
// Fire-and-forget: a missed push self-heals on the next connect transition.
function pushAgentDispatchConfig(maxConcurrent: number): void {
  hostConnection
    .sendCommand({ type: 'set-config', maxConcurrent })
    .then((res) => {
      if (!res.ok) {
        console.warn(`[fd-15] host rejected set-config: ${res.error}`);
      }
    })
    .catch((err) => {
      console.warn(
        `[fd-15] set-config push failed (will retry on next connect): ${(err as Error).message}`,
      );
    });
}
hostConnection.onHealthChange((h) => {
  if (h.state === 'connected') {
    pushAgentDispatchConfig(readSettings().agentDispatch.maxConcurrent);
  }
});

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
  getHostClient: () => hostConnection,
  broadcastFor: (projectId) => (event) => broadcastTo(projectId, event),
  // Workflow-review delivery seam. The closure runs at workflow-fire time
  // (post-boot), so it safely references the mailbox bindings declared later in
  // this module. Enqueues the review prompt as a durable mailbox message.
  deliverWorkflowReview: deliverWorkflowReview,
  // Failed-run notification seam (workflow-engine redesign). Notifies the human
  // inbox + the project orchestrator when a run fails.
  deliverWorkflowRunFailed: deliverWorkflowRunFailed,
  // First-run nudge — on a workflow's first completion, recommend the
  // workflow-doctor to the orchestrator (deduped once-per-workflow).
  deliverWorkflowRunCompleted: deliverWorkflowFirstRunReview,
  // M8 (FD-7) — decided-elsewhere inbox resolution. Closures evaluate at
  // decision time (post-boot), so the later mailboxService binding is safe.
  reviewInbox: {
    collectUnactionedRecipients: (sourceKind, sourceId) =>
      mailboxService.collectUnactionedRecipients(sourceKind, sourceId),
    actionRecipients: (ids, now) => mailboxService.actionRecipients(ids, now),
  },
});
// Command space — ensure the reserved global planning project exists before
// loadAll() so its runtime hydrates like any other project.
{
  const r = ensureCommandProject(DATA);
  console.log(`[command] project ${r.action} (${r.projectId})`);
}
projectRegistry.loadAll();

const projectCreate = new ProjectCreate(projectScaffold, projectRegistry);

// ☠ FD-3: the channel server (:8788) is gone — no inbound webhook door, no
// per-CC channel children, no `channel-event` UI bypass. The mailbox is the
// one notify door; if inbound integrations ever return, they come back as a
// plain HTTP endpoint that enqueues a mailbox message.

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

// Gap B (pc-pty-chat-338) — CC's first-run config (theme +
// hasCompletedOnboarding) is seeded SYNCHRONOUSLY inside
// applyClaudeRuntimeSettings (boot call above + every settings PATCH), so a
// user-triggered claude spawn can never race ahead of the seed and a
// claudeConfigDir change re-seeds the new profile.
// Background, non-blocking: stamp lastOnboardingVersion (NOT part of CC's gate).
void seedClaudeFirstRun(resolveClaudeBinary().path ?? 'claude').catch((err) => {
  console.warn(`[pc] claude-firstrun-seed version stamp failed: ${(err as Error).message}`);
});


// ── Slice 009 — mailbox value bindings RELOCATED above the boot handlers ──
// The boot-reattach / reconcile-sweep handlers below apply
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
  getMessageKind: (messageId) => getMailboxMessage(messageId)?.kind ?? null,
  // Issue 2 — staleness guard for agent-stalled messages.
  getMessageSource: (messageId) => {
    const msg = getMailboxMessage(messageId);
    return msg ? { sourceId: msg.sourceId ?? null, sourceKind: msg.sourceKind } : null;
  },
  getAgentRunStatus: (runId) => getAgentRunRow(runId)?.status ?? null,
});

// Slice 015b — the enqueue writes the canonical `mailbox.message.changed`
// outbox row inside its txn; the relay delivers it. No hand-fanout. (Name kept
// for the delivery-router cutover call sites; it is now a thin enqueue.)
function enqueueMailboxAndFanout(input: EnqueueMailboxMessageInput): MailboxEnqueuePublication {
  return mailboxService.enqueue(input);
}

// Step 2 — THE one agent-run reconciler (north-star §5: one loop, all states;
// boot is the same loop). Boot = the first tick: registers host-backed handles
// (self-healing on ANY tick after a held boot), backfills JSONL, applies
// terminal snapshots through the ONE terminal authority, and subscribes the ONE
// persistent host event stream (rides `hostConnection`'s multiplexed emitter).
// An unreachable host at boot ⇒ HOLD — never finalize on no-information; the
// loop converges when the host returns. Paused runs are NEVER finalized by the
// loop, any mode, boot included (FD-14 law).
const agentRunReconciler = createAgentRunReconciler({
  host: hostConnection,
  activeRunRegistry: getActiveRunRegistry(),
  broadcast: broadcastTo,
  mailboxEnqueue: enqueueMailboxAndFanout,
  // Issue 3 (near-term) — drain the mailbox immediately after the terminal
  // envelope is enqueued so the orchestrator learns about completion within
  // ms, not at the next 1s tick. The tick + S3 replay are the durable backstops.
  onMailboxEnqueued: () => {
    try {
      mailboxWorker.runOnce();
    } catch (err) {
      console.warn('[mailbox] immediate drain failed:', (err as Error).message);
    }
  },
  // pc-pty-chat-437 Fix E — re-home queued/spawning runs onto the current live
  // host when the original host was replaced between enqueue and spawn.
  reHomeQueuedRun: (row) => reHomeRunOnCurrentHost(row, hostConnection),
});
try {
  await agentRunReconciler.boot();
} catch (err) {
  console.error('[agent-runs] boot reconcile failed:', (err as Error).message);
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
        // M3a — the diary line the fail-close never wrote: a restarted server
        // is part of the run's story, not a silent status flip (FD-11).
        workflowRunGateway.appendRunEvent({
          projectId: run.projectId,
          runId: run.id,
          type: 'run_interrupted',
          data: { reason },
        });
      },
      // pc-pty-chat-270 Chunk B step 10: re-drive merge-in-progress runs via
      // the idempotent merge step instead of fail-closing them. Fail-close first
      // (clean state for resumeV2Run), then resume through the canonical door.
      reDriveMerge: (run) => {
        // 1. Fail-close (provides the `failed` status that resumeV2Run requires).
        workflowRunGateway.commitRunChange({
          projectId: run.projectId,
          reason: 'reconciled',
          mutate: () => {
            workflowRunsV2Repo.setStatus(run.id, 'failed', {
              lastReason: WORKFLOW_INTERRUPTED_ON_BOOT_REASON,
            });
            return workflowRunsV2Repo.getRun(run.id);
          },
        });
        workflowRunGateway.appendRunEvent({
          projectId: run.projectId,
          runId: run.id,
          type: 'run_interrupted',
          data: { reason: WORKFLOW_INTERRUPTED_ON_BOOT_REASON, mergeRetry: true },
        });
        // 2. Re-drive via the canonical resumeV2Run door (resets merge node to
        // pending → advance → idempotent mergeState check handles all git outcomes).
        let wf: WorkflowV2.Workflow | null = null;
        try {
          wf = JSON.parse(run.workflowYamlSnapshot) as WorkflowV2.Workflow;
        } catch {
          console.warn(`[boot-reconcile] merge re-drive: bad workflow snapshot for run ${run.id}`);
          return;
        }
        const runtime = projectRegistry.ensure(run.projectId as ULID);
        if (!runtime) {
          console.warn(`[boot-reconcile] merge re-drive: no runtime for project ${run.projectId} (run ${run.id})`);
          return;
        }
        runtime.resumeV2Run(run.id as ULID, wf).then((res) => {
          if (!res.ok) {
            console.warn(`[boot-reconcile] merge re-drive failed for run ${run.id}: ${res.error}`);
          } else {
            console.log(
              `[boot-reconcile] merge re-drive: run ${run.id} re-driven` +
              (res.resetNodes.length > 0 ? ` (reset: ${res.resetNodes.join(', ')})` : ''),
            );
          }
        }).catch((err: Error) => {
          console.error(`[boot-reconcile] merge re-drive async error for run ${run.id}:`, err.message);
        });
      },
    });
    if (wfResult.failed > 0 || wfResult.reDriven > 0) {
      console.log(
        `[workflow-runs] boot reconcile: failed-closed=${wfResult.failed}, re-driven=${wfResult.reDriven}, skippedPaused=${wfResult.skippedPaused}, scanned=${wfResult.scanned}`,
      );
    }
  } catch (err) {
    console.error('[workflow-runs] boot reconcile failed:', (err as Error).message);
  }
}

// Worktree sweep — backstop for the merge-node teardown. Reaps run worktrees
// whose branch already landed on the project's integration branch, merged
// orphan branches, and husk dirs left by interrupted removals. Worktrees
// referenced by any live run (agent: non-terminal; workflow: anything not
// completed/cancelled — failed runs keep theirs for resume/re-drive) are
// never touched.
//
// Runs at boot AND on an interval: out-of-band merges (orchestrator-run git)
// produce no event to hook, and the packaged daily driver rarely restarts —
// boot-only sweeping let merged worktrees pile up between reboots
// (2026-06-11 incident). This janitor is distinct from the ONE-RECONCILER
// run-state loop; see worktree-sweep-runner.ts.
// Worktree paths referenced by live runs — shared by the sweep AND the
// stranded report (pc-pty-chat-415 R14) so both agree on "in use".
const collectInUseWorktreePaths = (): string[] => {
  const inUse: string[] = [];
  for (const run of listNonTerminalAgentRuns()) {
    if (run.worktreeDir) inUse.push(run.worktreeDir);
  }
  for (const run of workflowRunsV2Repo.listRunsByStatus(['pending', 'running', 'paused', 'failed'])) {
    if (run.worktreePath) inUse.push(run.worktreePath);
  }
  return inUse;
};
const worktreeSweep = createWorktreeSweepRunner({
  listProjects: () => listProjects().map((p) => ({ id: p.id, slug: p.slug })),
  getRuntime: (projectId) => projectRegistry.get(projectId as ULID) ?? null,
  collectInUse: collectInUseWorktreePaths,
  dirExists: (p) => existsSync(p),
});
// Boot pass: fire-and-forget so a slow git/disk can't block startup.
void worktreeSweep.runOnce();
{
  const intervalMs = Number(process.env['PC_WORKTREE_SWEEP_INTERVAL_MS'] ?? 30 * 60_000);
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    const worktreeSweepTimer = setInterval(() => void worktreeSweep.runOnce(), intervalMs);
    if (typeof worktreeSweepTimer.unref === 'function') worktreeSweepTimer.unref();
  }
}

// pc-pty-chat-443: one-time boot removal of stranded `__dev-merge` worktrees
// across all projects. REAPABLE_NAME_RE matches `__merge-*` but not `__dev-*`,
// so the normal sweep never collects these dirs. Post-Fix-C no code path writes
// to them, so any remaining `__dev-merge` dir is a frozen orphan and safe to
// destroy. Fire-and-forget: a slow git/disk must not block startup.
void (async () => {
  for (const project of listProjects()) {
    const devMergePath = resolve(DATA, 'worktrees', project.slug, '__dev-merge');
    if (!existsSync(devMergePath)) continue;
    try {
      await _destroyWorktreeForCleanup(project.folderPath, devMergePath, { force: true });
    } catch {
      /* not registered or locked — best-effort; prune will clean the ref */
    }
    try {
      await _pruneWorktreesForCleanup(project.folderPath);
    } catch {
      /* best-effort — not fatal */
    }
    console.log(`[worktree-cleanup] removed stale __dev-merge for ${project.slug}`);
  }
})();

// pc-pty-chat-415 (R5) — accept ⇒ land. Wire the per-project WorktreeService
// accessor the landing service uses (services can't reach the project
// registry), then re-drive landings interrupted mid-flight ('pending' rows —
// the mechanics are idempotent, so a crash between merge and push converges).
// Fire-and-forget: a slow git/origin can't block startup.
setLandingWorktreesAccessor(
  (projectId) => projectRegistry.ensure(projectId)?.worktrees() ?? null,
);
void (async () => {
  try {
    for (const row of listContractsPendingLanding()) {
      const res = await landAcceptedContract(row.id);
      const detail = res.applicable ? res.outcome : `skipped (${res.reason})`;
      console.log(`[landing] boot re-drive contract ${row.id}: ${detail}`);
    }
  } catch (err) {
    console.error('[landing] boot re-drive failed:', (err as Error).message);
  }
})();

// Step 2 — start THE loop (the same tick boot just ran; the only liveness
// interval in the codebase — ONE-RECONCILER guard). Events = latency,
// reconcile = correctness: anything the live stream drops converges here.
agentRunReconciler.start();

const app = new Hono();

/** Holds resolvers for in-flight AskUserQuestion / ExitPlanMode calls. */
const pendingAsks = createPendingAskStore();

// ── Helpers ───────────────────────────────────────────────────────────────

/** Look up the runtime for a project handle (ULID | slug | name). Returns null
 *  if unknown. Slug and case-insensitive name lookups power cross-project tools
 *  so orchestrators can target a project by its human-readable handle. */
function resolveProject(projectId: string): ProjectRuntime | null {
  // 1. Fast path: exact ULID.
  const byId = projectRegistry.ensure(projectId as ULID);
  if (byId) return byId;
  // 2. Slug lookup (e.g. 'pc-pty-chat').
  const bySlug = getProjectBySlug(projectId);
  if (bySlug) return projectRegistry.ensure(bySlug.id);
  // 3. Case-insensitive name lookup (last resort).
  const lower = projectId.toLowerCase();
  const byName = listProjects().find((p) => p.name.toLowerCase() === lower);
  if (byName) return projectRegistry.ensure(byName.id);
  return null;
}

registerMcpBridgeRoutes(app, {
  dataDir: DATA,
  resolveProject,
  getHostClient: () => hostConnection,
});

// ── FD-2 (Step-4 Slice 0) — THE shared HTTP MCP tools endpoint ─────────────
// Every PC-spawned claude.exe calls here ({type:'http'} in its session-local
// mcp.json) instead of spawning a per-session stdio pc-rig child. Identity =
// signed claim headers (mcp-http-auth); the JSON-RPC `initialized` signal
// routes through the same handshake door the stdio child POSTed to.
const mcpHandshakeRouter = createMcpHandshakeRouter({
  dataDir: DATA,
  resolveProject,
  getHostClient: () => hostConnection,
});
const pcRigHttpEndpoint = createPcRigHttpEndpoint({
  serverPort: PORT,
  verify: (claims, token) => verifyMcpToken(mcpAuthSecret(DATA), claims, token),
  onInitialized: (claims) => {
    void mcpHandshakeRouter(claims.projectId, claims.agentSessionId).catch(() => {
      /* best-effort — ReadyGate timeout backstops a lost signal */
    });
  },
  log: (line) => console.log(`[pc] ${line}`),
});
app.all('/api/mcp', async (c) => {
  // The MCP transport writes the node response directly — hand it the raw
  // sockets and tell Hono the response is already gone.
  const { incoming, outgoing } = c.env as {
    incoming: IncomingMessage;
    outgoing: NodeServerResponse;
  };
  await pcRigHttpEndpoint.handleRequest(incoming, outgoing);
  return RESPONSE_ALREADY_SENT;
});

// ── Slice 007 — mailbox platform (additive; alongside Channel, no cutover) ──
// NOTE (slice 009): the mailbox VALUE bindings (mailboxService,
// mailboxSendService, mailboxOrchestratorTurnAdapter, mailboxWorker,
// deliveryRouter, enqueueMailboxAndFanout) were RELOCATED above the boot
// handlers (~:366) so the boot-reattach/reconcile/liveness handlers can carry
// the agent delivery gate without a const TDZ. The routes + worker setInterval
// stay here.
registerChatBridgeRoutes(app, {
  broadcastTo,
  pendingAsks,
});

registerMailboxRoutes(app, {
  mailbox: mailboxService,
  // Mailbox-message delivery rides the relay (015b); no fanout deps.
});

// Slice F — session-open checklist sweep. Hoisted (function declaration) so it
// can be referenced in the createRuntimeHostPtyController deps above; the body
// runs at ready-time (long after server init) so mailboxSendService is initialised.
function enqueueSessionOpenSweepForProject(projectId: ULID): void {
  const session = getActiveOrchestratorSession(projectId);
  if (!session) return;
  try {
    const items = listWorkItems(projectId, { open: true });
    const cards = collectOpenChecklistCards(items);
    const text = formatSweepBlock(cards);
    if (!text) return; // no open checklist cards — nothing to inject
    mailboxSendService.enqueueRuntimeTurn({
      projectId,
      sessionId: session.id as ULID,
      clientMessageId: sweepClientMessageId(session.id),
      text,
      source: 'mailbox',
    });
  } catch (err) {
    console.warn('[session-open-sweep] enqueue failed:', (err as Error).message);
  }
}

// Workflow-review delivery. Hoisted so the ProjectRegistry built at boot can
// reference it; the body runs at workflow-fire time so the const bindings above
// are initialised by then. Enqueues the review prompt as a durable mailbox
// message, routed by flavor (M8/FD-7 — a human gate is never invisible):
//   orchestrator → active-orchestrator (orchestrator-turn)
//   human (incl. ceiling escalation) → the human user-inbox (ui-inbox)
// The idempotency key arrives iteration-keyed from the dag-run-service, so a
// loop kick-back's re-review delivers AGAIN instead of dedup-vanishing (FD-8).
function deliverWorkflowReview(input: {
  projectId: ULID;
  runId: ULID;
  nodeId: string;
  flavor: 'human' | 'orchestrator';
  body: string;
  subject: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): boolean {
  const recipient =
    input.flavor === 'human'
      ? {
          id: newId(),
          addressKind: 'user-inbox',
          addressJson: { kind: 'user-inbox', userId: 'local-user', projectId: input.projectId },
          channel: 'ui-inbox' as const,
          deliveryId: newId(),
        }
      : {
          id: newId(),
          addressKind: 'active-orchestrator',
          addressJson: { kind: 'active-orchestrator', projectId: input.projectId },
          channel: 'orchestrator-turn' as const,
          deliveryId: newId(),
        };
  enqueueMailboxAndFanout({
    message: {
      id: newId(),
      projectId: input.projectId,
      kind: 'workflow-review',
      subject: input.subject,
      body: input.body,
      payload: input.payload,
      sourceKind: 'workflow-run-node',
      sourceId: `${input.runId}:${input.nodeId}`,
      idempotencyKey: input.idempotencyKey,
    },
    recipients: [recipient],
    now: Date.now(),
  });
  return true;
}

// Workflow-engine redesign — failed-run notification. Hoisted (referenced by the
// ProjectRegistry built at boot; the body runs at run-finalize time). Enqueues
// ONE durable `workflow-run-failed` message addressed to the project
// orchestrator ONLY (active-orchestrator, orchestrator-turn) so the AI can
// diagnose/repair. If no orchestrator is live the delivery DEFERS (M4a — parked
// without consuming attempts, rechecked every 60s) and lands when one exists —
// the run failure is never lost. (Pre-M4a this comment lied: the worker
// dead-lettered an orchestrator-less delivery on its FIRST pass.)
//
// A failed run is NOT a human-inbox card (user decision 2026-06-05): failures
// are run-history, not a decision demanding the human. The human reviews them in
// Workflows → Runs (filter: Failed), where the same "Resume from failed step"
// action already lives. resumeFailedDagRun still resolve-by-sources any open
// recipients (now just the orchestrator's) so resumed cards never linger.
function deliverWorkflowRunFailed(input: {
  projectId: ULID;
  runId: ULID;
  workflowName: string;
  workItemId: ULID | null;
  reason: string;
  /** 0-based failure incident (resume count at failure time). Keys the
   *  idempotency below: fail → resume → fail-again mints a FRESH card (FD-8);
   *  a crash-replay of the SAME incident still dedupes. */
  incident: number;
}): void {
  const body =
    `Workflow "${input.workflowName}" failed.\n\n` +
    `Reason: ${input.reason}\n` +
    `Run: ${input.runId}` +
    (input.workItemId ? `\nCard: ${input.workItemId}` : '') +
    // M3a — the diary IS the debugging read (FD-11): point the orchestrator at
    // it before it guesses from the one-line reason. M6 slice C — and at the
    // repair loop: fix the definition, then resume from the failed step.
    `\n\nFor the step-by-step story (which agent ran, what the review said, where it died): pc_get_workflow_run({ runId: "${input.runId}" }) via pc_call_tool.` +
    `\nFixable? Repair the definition (pc_update_workflow), then resume from the failed step — completed work is kept: pc_resume_workflow_run({ runId: "${input.runId}" }) via pc_call_tool.`;
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
      idempotencyKey: `workflow-run-failed:${input.runId}:${input.incident}`,
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
}

// First-run nudge: when a workflow finishes its FIRST run, recommend a
// workflow-doctor review to the orchestrator. The idempotency key is keyed on
// the workflow id (not the run), so the nudge lands exactly once per workflow —
// the first completion wins, every later completion dedupes to a no-op.
function deliverWorkflowFirstRunReview(input: {
  projectId: ULID;
  runId: ULID;
  workflowId: string;
  workflowName: string;
  workItemId: ULID | null;
}): void {
  const body =
    `Workflow "${input.workflowName}" just finished its first run.\n\n` +
    `First runs are when a workflow is least tuned — this is the moment to catch ` +
    `wasted steps, a specialist making excessive tool calls, the wrong model, or bad wiring.\n\n` +
    `Consider offering the user a review: dispatch the workflow-doctor on this run — ` +
    `pc_invoke_agent({ name: "workflow-doctor", input: "Review run ${input.runId} of workflow \\"${input.workflowName}\\" (${input.workflowId}) for inefficiencies and propose fixes." }). ` +
    `It reads the run + the agents' transcripts, finds problems, and applies approval-gated fixes.`;
  enqueueMailboxAndFanout({
    message: {
      id: newId(),
      projectId: input.projectId,
      kind: 'workflow-first-run-review',
      subject: `First run done: ${input.workflowName}`,
      body,
      payload: {
        runId: input.runId,
        workflowId: input.workflowId,
        workflowName: input.workflowName,
        workItemId: input.workItemId,
      },
      sourceKind: 'workflow-run',
      sourceId: input.runId,
      idempotencyKey: `workflow-first-run-review:${input.workflowId}`,
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
}

// ☠ FD-3: the external-webhook sink (`deliverWebhookToMailbox`) is gone with
// the channel server. Inbound integrations, if ever needed, return as a plain
// mailbox-writer endpoint.

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

// M4b (FD-8) — stale-ask watchdog: an open pc_ask_* past the threshold mints
// ONE actionable user-inbox card (idempotent per ask). Unref'd like the worker.
const staleAskSweep = setInterval(() => {
  try {
    sweepStalePendingAsks({ mailboxEnqueue: enqueueMailboxAndFanout });
  } catch (err) {
    console.warn('[mailbox] stale-ask sweep failed:', (err as Error).message);
  }
}, STALE_ASK_SWEEP_MS);
if (typeof staleAskSweep.unref === 'function') staleAskSweep.unref();

// pc-pty-chat-433 — A3: proactive work-item stall sweep. For each project,
// pushes ONE consolidated orchestrator-turn mailbox message when open items
// have had no activity for PC_WORK_ITEM_STALL_IDLE_DAYS (default 7). Debounced
// per-item per stall episode via `workItemNotifiedItems` (caller-owned state).
// Shares the stall query with A2 — both call getBoardHealth (@pc/db) directly.
const workItemNotifiedItems = new Map<string, Set<string>>();
const workItemStallSweep = setInterval(() => {
  try {
    const result = sweepWorkItemStallWarn({
      notifiedItems: workItemNotifiedItems,
      mailboxEnqueue: enqueueMailboxAndFanout,
    });
    if (result.notified > 0) {
      console.log(
        `[board-health] stall-sweep: checked=${result.checked}, notified=${result.notified}, newStalled=${result.newStalled}`,
      );
    }
  } catch (err) {
    console.warn('[board-health] stall sweep failed:', (err as Error).message);
  }
}, resolveWorkItemStallSweepMs());
if (typeof workItemStallSweep.unref === 'function') workItemStallSweep.unref();

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

registerSettingsOnboardingRoutes(app, {
  // FD-15 — saving Settings pushes the (already-clamped) cap to the live host.
  onSettingsApplied: (s) => pushAgentDispatchConfig(s.agentDispatch.maxConcurrent),
});

registerFileRoutes(app, {
  projectFolderPath: (projectId) => getProjectById(projectId)?.folderPath ?? null,
});

registerPastedImageRoutes(app, {
  getProject: (id) => getProjectById(id as ULID) ?? null,
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
  cancelInFlightRuns: async (projectId, slug) => {
    // M6 slice C — through the ONE cancel door (gateway cancel + diary line +
    // child agent-run cascade). The old direct writeRunStatus skipped the
    // `workflow_cancelled` diary line and left child workers running.
    const runs = workflowRunsV2Repo.listRunsByProject(projectId);
    for (const r of runs) {
      if (
        r.workflowId === slug &&
        (r.status === 'pending' || r.status === 'running' || r.status === 'paused')
      ) {
        await cancelWorkflowRunCascade({
          projectId,
          runId: r.id,
          getHostConnection: () => hostConnection,
        });
      }
    }
  },
  fireWorkflow: async (projectId, def, rootWorkItemId) => {
    const runtime = resolveProject(projectId);
    if (!runtime) throw new Error(`unknown project: ${projectId}`);
    return runtime.fireV2Workflow(def, rootWorkItemId);
  },
});

registerMcpServerRoutes(app, { resolveProject, probe: probeMcpServer });

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

registerWorkItemRoutes(app, {
  resolveProject,
  broadcastTo,
  refreshProject: (project) => projectRegistry.refresh(project),
  mailboxEnqueue: enqueueMailboxAndFanout,
  getHostConnection: () => hostConnection,
  // M8 (FD-7) — verification decisions action the contract's open inbox cards.
  reviewInbox: {
    collectUnactionedRecipients: (sourceKind, sourceId) =>
      mailboxService.collectUnactionedRecipients(sourceKind, sourceId),
    actionRecipients: (ids, now) => mailboxService.actionRecipients(ids, now),
  },
});

registerAreaRoutes(app, { resolveProject });

registerFocusRoutes(app, { resolveProject });

registerContextDocRoutes(app, { resolveProject });

registerContractRoutes(app, {
  mailboxEnqueue: enqueueMailboxAndFanout,
  getHostConnection: () => hostConnection,
  broadcastTo,
  // M8 (FD-7) — verification decisions action the contract's open inbox cards.
  reviewInbox: {
    collectUnactionedRecipients: (sourceKind, sourceId) =>
      mailboxService.collectUnactionedRecipients(sourceKind, sourceId),
    actionRecipients: (ids, now) => mailboxService.actionRecipients(ids, now),
  },
});

registerWorkflowCompatRoutes(app, {
  resolveProject,
  getHostConnection: () => hostConnection,
});

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
  // M4b (FD-8) — an ask decided through ANY door clears its open
  // `agent-ask-escalated` inbox cards.
  askInbox: {
    collectUnactionedRecipients: (sourceKind, sourceId) =>
      mailboxService.collectUnactionedRecipients(sourceKind, sourceId),
    actionRecipients: (ids, now) => mailboxService.actionRecipients(ids, now),
    dismissRecipients: (ids, now) => mailboxService.dismissRecipients(ids, now),
  },
  // Isolation invariant: when a dispatch declares isolation: "worktree", the
  // route provisions a real worktree before spawn via the project's
  // WorktreeService (same primitive the DAG executor uses).
  worktreeServiceFor: (projectId) => resolveProject(projectId)?.worktrees() ?? null,
  // pc-pty-chat-415 (R14) — the stranded report shares the sweep's in-use view.
  collectInUseWorktrees: collectInUseWorktreePaths,
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
    pendingAsks.resolve(id, answer);
  },
});

function gracefulShutdown(): void {
  agentRunReconciler.stop();
  clearInterval(mailboxWorkerSweep);
  clearInterval(staleAskSweep);
  clearInterval(workItemStallSweep);
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
