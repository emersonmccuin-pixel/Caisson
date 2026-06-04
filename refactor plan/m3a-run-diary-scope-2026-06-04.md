# M3a — the run diary becomes truth-grade (scope) — 2026-06-04

**FD-11 (locked):** the run diary is the truth + the orchestrator can read all of it — a stuck or
dead run is never a mystery. **FD-13 (locked):** happenings = append-only event logs.
**FD-12 bypass #2 (sentenced):** the diary writes that skip the gateway + `live_outbox`.
Ledger §6 row 12 ("workflow events = truth") + the P4-deferred boot-only-backfill gap land here.

## Scope split (decided this pass, breadcrumbed)

- **M3a (this):** the WORKFLOW diary — complete, gateway-guarded, orchestrator-readable,
  UI-visible. Plus the agent-run JSONL backfill any-tick gap (same "events lost to the UI" class).
- **M3b (split out):** chat-replay file → DB (`session-replay.ts` reads `jsonl-events.jsonl`;
  target = events in SQLite, replay = a query). Different subsystem (conversations), zero shared
  code with the workflow diary. Own pass.
- **M6 owns state-projection-from-events.** `dag_state` stays the execution store until the step
  model v3 rebuild — per sequencing: "build the new engine semantics on it ONCE (don't retrofit)."
  M3a lays the spine M6 builds on.
- **In-flight cutover: non-issue for M3a.** Execution reads don't change; pre-M3a runs simply have
  partial diaries (terminal runs unaffected; non-terminal runs fail-close on next boot anyway).

## Trace (verified)

- `workflow_run_events` (schema.ts:372) — exists, append-only, indexed by run. 13 kinds in the
  domain union; **ONE writer**: `dag-run-service.ts:426` (the executor's `event()` callback) →
  `workflowRunsV2Repo.appendEvent` DIRECT — the FD-12 bypass. No txn pairing, no outbox row.
- Emitted today (dag-executor.ts): node_started/completed/failed/skipped · review_requested
  (w/ bundle) /approved/rejected · iteration_ceiling_hit · card_moved · workflow_completed/failed.
- **NEVER written:** `workflow_started`, `workflow_cancelled` (declared in the union, zero call
  sites) · boot fail-close (`interrupted-on-boot`) leaves NO diary line · no record of WHICH
  agent run a node dispatched (the key debug breadcrumb).
- Run-row writes already go through `WorkflowRunMutationGateway` (M2 pattern: mutate + outbox row
  in one txn). The diary is the only workflow write outside it.
- **Readers: none.** The run-detail route returns events; `WorkflowsList.tsx` discards them. No
  pc_* tool reads run history (workflow tools = def-CRUD + fire). FD-11 readable = unbuilt.
- Backfill gap (P4 deferral): reconciler passes `backfillOnRegister: opts.boot === true` — a
  handle registered by the self-healing sweep AFTER boot gets no JSONL backfill; events the
  Engine emitted before dying mid-session never reach the UI (run still settles).

## Design

### Slice A — ONE diary door

`WorkflowRunMutationGateway.appendRunEvent({projectId, runId, type, nodeId?, data?})`:
one txn = `workflow_run_events` insert + `live_outbox` row (`type: 'workflow.run.event'`,
`entity: 'workflow-run-event'`, payload = the diary record + runId). The relay fans it like every
other fact. `dag-run-service`'s `event()` callback routes through it; the direct repo call dies.

New diary lines (union grows where needed):
- `workflow_started` — at fire (dag-run-service run start).
- `workflow_cancelled` — inside `gateway.cancelRun` (same txn as the status flip).
- `run_interrupted` (new kind) — boot fail-close writes its line (data: reason).
- `agent_dispatched` (new kind) — from the node executor after dispatch returns;
  data `{ agentRunId, workItemId }` → the diary cross-links to the agent run for FD-11 debugging.

Guard: structural test — `appendEvent(` callable only from the gateway (no-bypass pattern);
banned-direct import check for `workflowRunsV2Repo.appendEvent` outside it.

### Slice B — readable + visible

- **Tool `pc_get_workflow_run`** (on-demand tier per FD-16; reachable via pc_find_tool/pc_call_tool):
  input runId → `{ run: {status, lastReason, startedAt/endedAt}, diary: [...] }` with diary lines
  rendered plain-English ("step write: agent dispatched (run 01…)", "review rejected — notes: …").
  Golden 53→54 (regen ritual: tsx script, keep frozen `capabilities`).
- **UI:** `RunInlineDetail` renders the diary timeline (ts + plain line, newest last, collapsed
  beyond ~20); appends/refetches on `workflow.run.event` live frames for the open run.

### Slice C — backfill any-tick

`backfillOnRegister` = true whenever the sweep REGISTERS a missing handle (registration is the
rare event, not the tick). Verify the replay writer's cursor dedup tolerates a second backfill of
already-replayed lines before flipping (else floor it).

## Verification (live)

1. Fire `file-then-review` + reject once → diary shows: started → node started → agent_dispatched
   (real runId) → delivered/completed → review requested → rejected (notes) → re-dispatch →
   approved → card_moved → workflow_completed — live in the UI panel, no refresh.
2. Cancel a run → `workflow_cancelled` line lands w/ the status flip (one txn).
3. Orchestrator chat: ask it to investigate the run → it finds + calls pc_get_workflow_run via the
   on-demand door → narrates the story from the diary.
4. Kill the host mid-run → post-respawn handle re-registration backfills the missed JSONL events.
5. Gates: appendEvent-door structural test + suites + typecheck green.

## Out of scope (breadcrumbs)

- M3b chat-replay→DB (`session-replay.ts` / `jsonl-events.jsonl`) — own pass.
- State projection from events + restart-at-step → M6 (FD-11 requirement rides the step-model v3).
- agent-audit `appendWorkItemHistory` fold — verified: it writes informational WI-history
  entries (agent-comms audit, no version bump, receipt-less by design; allowlisted in the
  no-bypass gate with an "M3" tombstone). It is a WORK-ITEM activity concern, not a workflow-run
  happening — folding it into an event log rides the work-item activity model (M5/M6), not this
  diary. Gate-note updated to point there; no code change here.
