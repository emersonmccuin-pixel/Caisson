// Slice 015c — the NO-BYPASS static gate.
//
// Invariant (ADR "no-bypass"): the live-relay is the SOLE delivery path for
// DB-owned facts. Every UI-bound WS fan-out must flow FROM the durable
// `live_outbox` door via the relay — never via a hand-written `broadcast*`.
//
// This test statically scans the server + web SOURCE (not tests) for any
// OCCURRENCE of the UI fan-out primitives (a call OR passing one as a value,
// e.g. `announcePod(id, deps.broadcastAll)`) and fails if any appears OUTSIDE:
//   (a) the relay itself (`apps/server/src/services/live-relay.ts`), or
//   (b) the EXPLICIT allowlist below — legitimate separate-channel / pass-through
//       pushes, each with a one-line justification.
//
// Matching is by file + symbol/context (regex over call expressions), NOT line
// numbers, so it is robust to code moving within a file. A NEW `broadcast*` /
// `fanoutMessage` call landing in a non-allowlisted file FAILS the gate.
//
// To extend the allowlist you MUST add a real justification here. Do not widen
// it silently — a DB-owned fact belongs on the relay door, not the allowlist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
// .../apps/server/test/no-bypass-gate.test.ts -> repo root
const repoRoot = join(here, '..', '..', '..', '..');

// The UI fan-out primitives. `broadcastTo`/`broadcastAll` are the index.ts hub
// helpers (and the dep lambdas that forward to them). The snapshot variants ride
// the same hub. `fanoutMessage` is the (now-deleted) mailbox hand-fanout — kept
// here so reintroducing it FAILS the gate. `wsHub.broadcast*` is the raw hub.
const GATED_SYMBOLS = [
  'broadcastTo',
  'broadcastAll',
  'broadcastRuntimeSnapshot',
  'broadcastSendQueueSnapshot',
  'fanoutMessage',
];

// Any OCCURRENCE of a gated symbol as a standalone identifier — whether called
// (`broadcastAll(x)`) or value-passed (`announcePod(id, deps.broadcastAll)`).
// The `\b` word boundaries keep it from matching substrings; the optional member
// prefix is consumed by the boundary so `deps.broadcastAll` matches on the symbol
// itself.
const SYMBOL_RE = new RegExp(String.raw`\b(${GATED_SYMBOLS.join('|')})\b`, 'g');
// Raw project-scoped hub fan-out (the actual socket write), qualified by the hub
// object so it never false-matches a dep param named `broadcast`. `broadcastAll`
// is already in GATED_SYMBOLS; this adds the project-scoped `.broadcast(` method.
const RAW_HUB_RE = /\b(?:wsHub|hub)\.(broadcast)\s*\(/g;
// TS interface / type method declaration: `name(args): ReturnType;` — these are
// type signatures, not real fan-out, so they don't count as a bypass.
const DECL_RE = new RegExp(
  String.raw`^\s*(?:readonly\s+)?(?:${GATED_SYMBOLS.join('|')})\s*\([^)]*\)\s*:\s*\w`,
);

// 017 Phase C — the Channel-delivery primitives that were DELETED when the
// mailbox became the sole delivery door. Reintroducing ANY of these in
// apps/server/src means the legacy Channel push path is coming back — a
// regression with NO allowlist. The gate trips on the bare identifier anywhere
// in source (calls, imports, decls), ignoring comments.
// FD-12 (M2): `announceWorkItem`/`announceWorkItemRow` (the deleted two-step
// work-item-writer — save in one txn, receipt in another, crash window in
// between) join the banned set. The one door is WorkItemMutationGateway.
// P2 (ledger row 3): `constructAndStart`/`defaultAgentRunFactory`/
// `activeRunHandleForAgentRun` (the deleted in-process spawn fallback) join
// too — the agent host owns every spawn (ONE-SPAWN-OWNER); no hostClient is a
// typed `host-unavailable` failure, never an alternate spawn path.
const BANNED_RESURRECTION = [
  'enqueueAndPush',
  'drainPendingForSession',
  'emitToSession',
  'forwardToProjectChildren',
  'announceWorkItemRow',
  'announceWorkItem',
  'constructAndStart',
  'defaultAgentRunFactory',
  'activeRunHandleForAgentRun',
  // Step-4 Slice 2: the server-owned orchestrator spawn is dead — the Engine
  // owns EVERY Claude process; the chat rides OrchestratorHostSession on a
  // `persistent-interactive` host run.
  'InteractiveSession',
  // P7 (FD-21): the transient modal sessions are deleted — agent-designer /
  // workflow-builder / setup-wizard popups + the workflow draft store.
  // Authoring flows through the orchestrator chat + dispatched specialists.
  'registerTransientSessionRoutes',
  'startAgentDesigner',
  'startWorkflowBuilder',
  'startSetupWizard',
  'hasLiveTransientSession',
  'setWorkflowBuilderDraft',
  'getWorkflowBuilderDraft',
  'pc_save_workflow_draft',
  'pc_read_workflow_draft',
  // P8 (Step 6): the primitive converged — PtySession + its banner-regex
  // ready detector + the timing-guess sender + the dead AgentRun reattach
  // lane are deleted. LowLevelSpawn/AgentRun + ReadyGate + echo-ack are the
  // ONE spawn/ready/send path.
  'PtySession',
  'terminalBufferLooksReady',
  'TimedBracketedPasteQueue',
  'reattachLifecycle',
  // P9 (Step 8/FD-17): silence escalates, it never executes. The idle-kill +
  // resume first-turn watchdog are deleted from AgentRun; quiet runs are the
  // reconciler ladder's business (badge → verify-alive → notify).
  'armIdleTimer',
  'resetIdleTimer',
  'armFirstTurnWatchdog',
  'sweepAgentRunLiveness',
  // M4a (FD-12 bypass #3): the agent_inbox path is deleted whole — the
  // mailbox is the ONE delivery system.
  'enqueueInboxRow',
  'markInboxDelivered',
];
const BANNED_RE = new RegExp(String.raw`\b(${BANNED_RESURRECTION.join('|')})\b`, 'g');

// The relay is the canonical door — always allowed.
const RELAY_FILE = 'apps/server/src/services/live-relay.ts';

// ── The allowlist (separate-channel / pass-through — KEEP, each justified) ─────
// Keyed by repo-relative POSIX path. Every gated call in these files is a
// legitimate non-relay push for the stated reason.
const ALLOWLIST: Record<string, string> = {
  // The relay wiring + the two index.ts hub helpers (`broadcastTo`/`broadcastAll`
  // wrap `wsHub`) live here, plus the relay's global `broadcastAll` for
  // project.changed frames. This file IS the fan-out plumbing the relay drives.
  'apps/server/src/index.ts':
    'Hub plumbing: defines + wraps wsHub.broadcast(All); the relay drains the outbox through these helpers. Snapshot helpers ride the same hub.',

  // ── Snapshots / telemetry — separate channel, reconnect catch-up exists ──
  'apps/server/src/features/statusline/routes.ts':
    'Statusline snapshot (telemetry-adjacent, high-frequency); separate coalesced channel per ADR §4, a missed tick is pure latency.',
  'apps/server/src/services/orchestrator-send-queue-delivery.ts':
    'Orchestrator send-queue snapshot push; full-replace snapshot, re-pushed on connect (websocket-connect.ts). Not a reconcilable outbox fact.',

  // ── Live RPC gate / ephemeral — not reconcilable facts ──
  'apps/server/src/features/chat-bridges/routes.ts':
    'ask: live RPC gate, latency-class. The durable record already rides the relay via the pending-interaction outbox row.',

  // ── PTY / live I/O pass-through (ADR §4) — raw byte/event streams ──
  'apps/server/src/features/runtime-host/pty-handlers.ts':
    'PTY pass-through: raw run-output/state/turn-end/event/exit + runtime snapshot. Latency-class live I/O, never an outbox fact.',
  'apps/server/src/features/runtime-host/routes.ts':
    'Chat-session live channel: session-changed lifecycle + sessionReplay transcript bytes + runtime/send-queue snapshots. Transcript/PTY tier (ADR §4); session-changed is re-pushed on connect.',
  'apps/server/src/features/runtime-host/websocket-message.ts':
    'Chat-session live channel (per-socket): session-changed + sessionReplay transcript payload on user turn. Transcript pass-through tier (ADR §4).',
  'apps/server/src/features/runtime-host/websocket-server.ts':
    'Plumbing: destructures + forwards the broadcastTo / send-queue-snapshot helpers into the per-connection handler (no new fan-out; the targets are themselves allowlisted pass-through).',
  'apps/server/src/services/conversation-send.ts':
    'Plumbing: forwards the broadcastSendQueueSnapshot helper into ConversationSendService (snapshot push; allowlisted separate channel).',

  // ── Agent live-transcript / dispatch pass-through ──
  // The agent-run LIFECYCLE fact rides the relay (agent-run-writer + gateway
  // outbox row). The `broadcast` dep these files inject carries the latency-class
  // `agent-jsonl-event` live-transcript stream + kill/inspect acks, not facts.
  'apps/server/src/features/agent-runs/routes.ts':
    'Injects the agent broadcast dep that fans latency-class agent-jsonl-event + kill acks. Agent-run lifecycle facts ride the relay (agent-run-writer outbox row).',
  'apps/server/src/features/work-items/routes.ts':
    'Injects the agent-dispatch broadcast dep (reject→dispatch fans agent-jsonl-event). Work-item facts ride the door (patch() announces internally).',
  // NOTE: agent-run-factory.ts fans `agent-jsonl-event` (live-transcript modal,
  // ADR §4 pass-through) but through a bare `broadcast` param, so it is not a
  // gated-symbol site and needs no allowlist entry.
};

// Slice 015b-tail: pods migrated onto the relay. pod-routes.ts no longer
// hand-fans `pod-changed`; the pod-writer writes a `pod.changed` live_outbox
// row in-txn and the relay delivers it. The pod-routes DEFERRED allowlist entry
// was removed (no gated symbol remains there).

// ── FD-12 (M2) — work-item WRITE-DOOR gate ────────────────────────────────────
// Every durable work_items mutation must run INSIDE a WorkItemMutationGateway
// commit (repo write + work-item.changed receipt in ONE transaction). The @pc/db
// mutator functions are the raw table writers; importing one into a NEW
// apps/server file is how a bypass quietly appears. Importing them is allowed
// ONLY in the files below — each routes the call through the gateway (or is an
// explicitly-tombstoned legacy writer with a dated fate).
const WORK_ITEM_MUTATORS = [
  'createWorkItem',
  'moveWorkItemStage',
  'updateWorkItemFields',
  'updateWorkItemStatus',
  'patchWorkItem',
  'softDeleteWorkItem',
  'restoreWorkItem',
  'reassignStage',
  'applyRunOutcome',
  'appendWorkItemHistory',
];
// Matches the whole (possibly multiline) `import {...} from '@pc/db'` statement.
const DB_IMPORT_RE = /import\s*(type\s+)?\{([^}]*)\}\s*from\s*['"]@pc\/db['"]/g;

const MUTATOR_IMPORT_ALLOWLIST: Record<string, string> = {
  'apps/server/src/services/work-item.ts':
    'WorkItemService — create/patch/move/softDelete/restore all run inside gateway.commitWorkItemChange.',
  'apps/server/src/services/agent-verification.ts':
    'applyRunOutcome + auto-advance inside gateway.tryCommitWorkItemChange (verified/auto-advanced receipt).',
  'apps/server/src/services/agent-verification-review.ts':
    'applyRunOutcome inside gateway commits (approved/auto-advanced/rejected receipts).',
  'apps/server/src/services/dag-run-service.ts':
    'moveCard transition effect — moveWorkItemStage inside gateway.tryCommitWorkItemChange.',
  'apps/server/src/services/project-runtime.ts':
    'legacy no-expectedVersion move (pc_move_work_item) — moveWorkItemStage inside gateway.commitWorkItemChange.',
  'apps/server/src/services/apply-deliverable-store.ts':
    'prose→work_item_body store — updateWorkItemFields inside gateway.tryCommitWorkItemChange.',
  'apps/server/src/services/auto-advance-done.ts':
    'helper ONLY: returns the moved row to callers that wrap it in their own gateway commit (verification paths).',
  'apps/server/src/services/agent-audit.ts':
    'appendWorkItemHistory is audit-only (no version bump, deliberately no receipt). M3a verdict 2026-06-04: a WORK-ITEM activity concern, not a run happening — the fold rides the WI activity model (M5/M6), not the run diary.',
  'apps/server/src/features/work-items/routes.ts':
    'fields-only PATCH via gateway; reassignStage = stage-delete bulk fallback whose receipt rides stage.list.changed.',
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'archive' || name === 'test') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Scan one file for gated call sites, ignoring comments + type declarations. */
function gatedCallsIn(content: string): { line: number; symbol: string }[] {
  const hits: { line: number; symbol: string }[] = [];
  const lines = content.split(/\r?\n/);
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Strip block comments (best-effort, line-granular).
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const open = line.indexOf('/*');
    if (open !== -1 && line.indexOf('*/', open) === -1) {
      inBlockComment = true;
      line = line.slice(0, open);
    }
    // Strip line comments.
    const lc = line.indexOf('//');
    if (lc !== -1) line = line.slice(0, lc);
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Type signatures + import/export statements are not fan-out — skip.
    if (DECL_RE.test(line)) continue;
    if (/^(import|export)\b/.test(trimmed) && /['"]/.test(trimmed)) continue;

    SYMBOL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SYMBOL_RE.exec(line)) !== null) {
      hits.push({ line: i + 1, symbol: m[1] });
    }
    RAW_HUB_RE.lastIndex = 0;
    while ((m = RAW_HUB_RE.exec(line)) !== null) {
      hits.push({ line: i + 1, symbol: `hub.${m[1]}` });
    }
  }
  return hits;
}

/** Scan one file for any banned (deleted) Channel-delivery primitive, ignoring
 *  comments. Any hit is a resurrection of the legacy path. */
function bannedCallsIn(content: string): { line: number; symbol: string }[] {
  const hits: { line: number; symbol: string }[] = [];
  const lines = content.split(/\r?\n/);
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const open = line.indexOf('/*');
    if (open !== -1 && line.indexOf('*/', open) === -1) {
      inBlockComment = true;
      line = line.slice(0, open);
    }
    const lc = line.indexOf('//');
    if (lc !== -1) line = line.slice(0, lc);
    if (!line.trim()) continue;
    BANNED_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BANNED_RE.exec(line)) !== null) {
      hits.push({ line: i + 1, symbol: m[1] });
    }
  }
  return hits;
}

const scanRoots = ['apps/server/src', 'apps/web/src'].map((p) => join(repoRoot, ...p.split('/')));

test('no-bypass gate: UI fan-out only in the relay + the documented allowlist', () => {
  const offenders: string[] = [];
  const filesWithCalls = new Set<string>();

  for (const root of scanRoots) {
    for (const file of listSourceFiles(root)) {
      const rel = toPosix(relative(repoRoot, file));
      if (rel === RELAY_FILE) continue; // the door is always allowed
      const hits = gatedCallsIn(readFileSync(file, 'utf8'));
      if (hits.length === 0) continue;
      filesWithCalls.add(rel);
      if (!(rel in ALLOWLIST)) {
        const detail = hits.map((h) => `L${h.line} ${h.symbol}`).join(', ');
        offenders.push(`${rel} — ${detail}`);
      }
    }
  }

  assert.equal(
    offenders.length,
    0,
    `Found ${offenders.length} UI fan-out call(s) outside the relay + allowlist. ` +
      `A DB-owned fact must ride the live_outbox door via the relay; a genuine ` +
      `pass-through must be added to the ALLOWLIST in this file WITH a justification:\n` +
      offenders.map((o) => `  - ${o}`).join('\n'),
  );

  // Self-maintaining: an allowlist entry that no longer matches any real call
  // site is stale and must be removed (keeps the allowlist honest + minimal).
  const stale = Object.keys(ALLOWLIST).filter((p) => !filesWithCalls.has(p));
  assert.equal(
    stale.length,
    0,
    `Stale allowlist entr${stale.length === 1 ? 'y' : 'ies'} — no gated call site ` +
      `remains; delete from ALLOWLIST:\n` + stale.map((p) => `  - ${p}`).join('\n'),
  );
});

test('no-bypass gate: deleted Channel-delivery primitives stay deleted (017 Phase C)', () => {
  const offenders: string[] = [];
  const serverSrc = join(repoRoot, 'apps', 'server', 'src');
  for (const file of listSourceFiles(serverSrc)) {
    const hits = bannedCallsIn(readFileSync(file, 'utf8'));
    if (hits.length === 0) continue;
    const rel = toPosix(relative(repoRoot, file));
    offenders.push(`${rel} — ${hits.map((h) => `L${h.line} ${h.symbol}`).join(', ')}`);
  }
  assert.equal(
    offenders.length,
    0,
    `Channel-delivery primitive resurrected. The mailbox is the sole delivery ` +
      `door (017 Phase C); these were deleted and must not return:\n` +
      offenders.map((o) => `  - ${o}`).join('\n'),
  );
});

/** All work-item mutators named in this file's `@pc/db` VALUE imports.
 *  `import type {...}` carries no runtime write capability and is ignored. */
function mutatorImportsIn(content: string): string[] {
  const found: string[] = [];
  DB_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DB_IMPORT_RE.exec(content)) !== null) {
    if (m[1]) continue; // type-only import
    const names = m[2]!;
    for (const mut of WORK_ITEM_MUTATORS) {
      if (new RegExp(String.raw`\b${mut}\b`).test(names)) found.push(mut);
    }
  }
  return found;
}

test('FD-12 gate: work-item mutator imports only in gateway-routed files', () => {
  const offenders: string[] = [];
  const filesWithImports = new Set<string>();
  const serverSrc = join(repoRoot, 'apps', 'server', 'src');
  for (const file of listSourceFiles(serverSrc)) {
    const muts = mutatorImportsIn(readFileSync(file, 'utf8'));
    if (muts.length === 0) continue;
    const rel = toPosix(relative(repoRoot, file));
    filesWithImports.add(rel);
    if (!(rel in MUTATOR_IMPORT_ALLOWLIST)) {
      offenders.push(`${rel} — imports ${muts.join(', ')}`);
    }
  }
  assert.equal(
    offenders.length,
    0,
    `Found ${offenders.length} file(s) importing raw work-item mutators from @pc/db ` +
      `outside the FD-12 allowlist. A durable work-item change goes through ` +
      `WorkItemMutationGateway (write + receipt in ONE transaction); route the call ` +
      `through the gateway, then add the file here WITH a justification:\n` +
      offenders.map((o) => `  - ${o}`).join('\n'),
  );

  // Self-maintaining: stale allowlist entries must be removed.
  const stale = Object.keys(MUTATOR_IMPORT_ALLOWLIST).filter((p) => !filesWithImports.has(p));
  assert.equal(
    stale.length,
    0,
    `Stale FD-12 allowlist entr${stale.length === 1 ? 'y' : 'ies'} — no mutator import ` +
      `remains; delete from MUTATOR_IMPORT_ALLOWLIST:\n` +
      stale.map((p) => `  - ${p}`).join('\n'),
  );
});

test('FD-12 gate: would FAIL on a planted mutator import (self-check)', () => {
  const planted = `import { getWorkItem, patchWorkItem } from '@pc/db';\n`;
  assert.deepEqual(mutatorImportsIn(planted), ['patchWorkItem']);
  // Multiline import blocks must match too.
  const multiline = `import {\n  createWorkItem as dbCreateWorkItem,\n  listWorkItems,\n} from '@pc/db';\n`;
  assert.deepEqual(mutatorImportsIn(multiline), ['createWorkItem']);
  // Type-only imports carry no write capability.
  const typeOnly = `import type { patchWorkItem } from '@pc/db';\n`;
  assert.deepEqual(mutatorImportsIn(typeOnly), []);
  // Read-only imports stay clean.
  const readOnly = `import { getWorkItem, listWorkItems } from '@pc/db';\n`;
  assert.deepEqual(mutatorImportsIn(readOnly), []);
});

test('no-bypass gate: would FAIL on a planted bypass (self-check)', () => {
  // Sanity-check the detector itself: a synthetic non-allowlisted file with a
  // gated call must be flagged. (We assert the scanner logic, not the tree.)
  const planted = `export function leak(broadcastAll: (m: unknown) => void) {\n  broadcastAll({ type: 'sneaky-fact' });\n}\n`;
  const hits = gatedCallsIn(planted);
  assert.ok(
    hits.some((h) => h.symbol === 'broadcastAll'),
    'detector must catch a planted broadcastAll() call',
  );

  // And it must NOT flag a pure type declaration or a comment.
  const decl = `export interface Deps {\n  broadcastAll(msg: unknown): void;\n}\n`;
  assert.equal(gatedCallsIn(decl).length, 0, 'detector must ignore interface method decls');
  const comment = `// broadcastAll(foo) in a comment must be ignored\nconst x = 1;\n`;
  assert.equal(gatedCallsIn(comment).length, 0, 'detector must ignore comments');

  // The resurrection detector must catch a planted Channel primitive...
  const planted2 = `channelServer.emitToSession({ recipientSessionId: 's' });\n`;
  assert.ok(
    bannedCallsIn(planted2).some((h) => h.symbol === 'emitToSession'),
    'detector must catch a planted emitToSession call',
  );
  // ...and ignore a mere mention in a comment.
  const banComment = `// the deleted enqueueAndPush primitive must be ignored here\nconst y = 1;\n`;
  assert.equal(bannedCallsIn(banComment).length, 0, 'resurrection detector must ignore comments');
});
