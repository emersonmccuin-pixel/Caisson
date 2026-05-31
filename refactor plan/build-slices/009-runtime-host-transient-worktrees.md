# 009 Runtime Host: Boot-Order Mailbox Gate, Host Resume-Send, Echo-Timeout Composer Recovery

Reprioritized slice. Fix the three confirmed runtime-host defects gating the slice-008 cutover and the slice-006 send queue; scope the broader runtime-host / transient-worktree split DOWN to only what these defects require, defer the rest to slice 011.

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-05-31 |
| Branch | `refactor/auto-pathway` |
| Commit | HEAD ~ `fb70b1b5` (trust the tracker; slices 001-008 built; hotfixes `e22456d2` + `1f9f4262` landed) |
| Artifact status | Planned build slice |
| Owning roadmap phase | Phase 10 runtime-host / transient-worktree split |
| Slice subject | (1) wire the agent->mailbox delivery gate into the boot-wired host-terminal handlers (LEAD); (2) fix host-backed agent resume dropping the answer; (3) fix the slice-006 echo-timeout composer gluing root in `send-protocol.ts`. |
| Implementation target | This repo. No parallel app. |
| Scope rule | Build plan only. Do not implement until the user asks to build. Do not restart dev servers. |

Decision: the pathway's nominal 009 ("split runtime host, transient sessions, worktree/path-guard seams behind a compatibility facade") is REPRIORITIZED. The three concrete defects ARE the runtime-host boundary work that matters now; a speculative interface-extraction refactor is explicitly DEFERRED to slice 011 cleanup. This slice touches the host boot wiring, the host/in-process resume divergence, and the PTY send protocol — exactly the runtime-host seam — but only as far as the three defects require. No new compatibility facade is invented.

## 2. Objectives

### OBJECTIVE 1 (LEAD) — agent->mailbox boot-order gate-wiring

Confirmed behaviorally 2026-05-31: with `PC_DELIVERY_AGENT=mailbox`, a dispatched agent's completion still writes an `agent_inbox` row (Channel) instead of one orchestrator mailbox turn.

Root cause (verified in code):
- The factory's live host handler IS gated correctly: `startHostBackedRun` (`agent-run-factory.ts:606`, `:689`) passes `deliveryRouter` + `mailboxEnqueue` into `applyHostTerminalSnapshot`, which forwards them to `applyAgentRunTerminalEffects` -> `emitTerminalEnvelope` -> `deliverAgentEnvelope`. This is hotfix `e22456d2`, unit-proven by `agent-host-terminal-gate.test.ts`. Necessary but INSUFFICIENT.
- The THREE boot-wired host-terminal handlers do NOT pass the mailbox port:
  - boot reattach: `index.ts:371` `reattachAgentRunsDuringServerBoot({ broadcast: broadcastTo, channelServer })` — no `deliveryRouter`, no `mailboxEnqueue`.
  - reconcile sweep: `index.ts:413` `reconcileAgentRunsAgainstHost({ hostClient, broadcast: broadcastTo, channelServer })` — same omission. Runs every 15s (`AGENT_RUN_RECONCILE_SWEEP_MS`).
  - liveness sweep: `index.ts:442` `sweepAgentRunLiveness({ activeRunRegistry, channelServer, broadcast })` — same omission. Runs every 30s; host-mode early-returns at `index.ts:440` BUT the `finalize` path in `agent-run-liveness-sweep.ts:122` also omits the port for the in-process path.
- All three terminate via `applyHostTerminalSnapshot` / `applyAgentRunTerminalEffects` -> `emitTerminalEnvelope` (`agent-run-terminal-effects.ts:189`). There the router defaults to `deps.deliveryRouter ?? envDeliveryRouter()` (so the gate IS read at apply time and resolves to `mailbox`), but `mailboxEnqueue` defaults to `deps.mailboxEnqueue ?? null`. `deliverAgentEnvelope` (`agent-delivery.ts:238`) takes the mailbox path ONLY when `router.mode('agent') === 'mailbox' AND deps.mailboxEnqueue` is truthy. With a null port it FALLS THROUGH to `enqueueAndPush` (Channel). That is the silent no-op-to-Channel.
- Why it WINS the race: the boot reattach + the 15s reconcile sweep both run `applyHostTerminalSnapshot`, which is idempotent on `agent_runs` (`isDbTerminal` guard at `agent-run-terminal-effects.ts:81`). Whichever handler applies the terminal FIRST writes the delivery; the factory's gated live handler then no-ops on the already-terminal row. In host mode the boot/sweep handlers commonly fire first -> Channel wins.

Why a direct boot-time reference hits TDZ: the boot block runs at `index.ts:371` (an inline `await`); the sweeps' `setInterval` is created at `:405`/`:439`. But `mailboxService` (`const`, `:477`), `deliveryRouter` (`const`, `:538`), and `enqueueMailboxAndFanout` (`function`, `:540`) are all declared AFTER. A direct `const` reference from line 371/405/439 is a temporal-dead-zone access and throws at boot.

Chosen fix mechanism: **(a) construct the mailbox bindings EARLIER, before the boot handlers, and pass them in directly.** See section 5 for the precise move and the (a)-vs-(b) justification.

Files/functions to touch:
- `apps/server/src/index.ts` — relocate the mailbox-platform construction block (`mailboxService` `:477`, `deliveryRouter` `:538`, `enqueueMailboxAndFanout` `:540`, and the bindings `enqueueMailboxAndFanout` depends on: `broadcastAll`/`broadcastTo` already exist by `:232`; `MailboxService` import already present) to BEFORE the boot-reattach block at `:369`. Then pass `deliveryRouter` + `mailboxEnqueue: enqueueMailboxAndFanout` into all three handler calls at `:371`, `:413`, `:442`.
- `apps/server/src/services/agent-run-liveness-sweep.ts` — `LivenessSweepDeps` + `finalize` (`:116`) thread `deliveryRouter`/`mailboxEnqueue` into the `applyAgentRunTerminalEffects` deps (`:140`).
- No change needed in `agent-host-reattach.ts` / `agent-run-server-boot.ts` / `agent-run-terminal-effects.ts`: the params already exist (`AgentHostReattachDeps.deliveryRouter`/`.mailboxEnqueue` at `agent-host-reattach.ts:69`/`:73`; `AgentRunServerBootDeps extends Omit<AgentHostReattachDeps,'hostClient'>` at `agent-run-server-boot.ts:27`; `reconcileAgentRunsAgainstHost` shares `AgentHostReattachDeps`). The plumbing is already there — the boot CALL SITES just never supplied the port.

### OBJECTIVE 2 — host-backed agent resume drops the answer

Answering a paused host-backed run flips the ask to `answered` (durable layer correct) and fires a resume spawn, but the answer is never delivered as the agent's next user turn; the run sits idle until the liveness sweep fails it. In-process resume works.

Call chain (verified):
- `answerPendingAsk` (`pause-resume.ts:251`) validates resumability, atomically flips open->answered via `answerAndResumeAgentRun`, then `entry.run.resumeWithAnswer(input.answer)` (`:338`).
- In-process: `entry.run` is `activeRunHandleForAgentRun` (`agent-active-runs.ts:36`) -> `run._resumeWithAnswer(answer)` -> `AgentRun._resumeWithAnswer` (`agent-run.ts:315`) -> `runSpawnPhase('resume', answer)` -> `await spawn.send(answer)` (`agent-run.ts:432`). Works.
- Host-backed: `entry.run` is `HostBackedActiveRunHandle` (`agent-active-runs.ts:61`). `resumeWithAnswer` (`:105`) issues `{ type:'answer-pending', runId, text:answer }` to the host. Host `answerPending` (`agent-host-service.ts:352`) -> `entry.run._resumeWithAnswer(text)` on the HOST-side `AgentRun` -> same `runSpawnPhase('resume', answer)` -> `await spawn.send(answer)`.

The divergence is on the host PTY resume-send. Two verified guards that can silently swallow the answer:
1. `_resumeWithAnswer` early-returns if `this.state !== 'paused'` (`agent-run.ts:316`) or if `this.cancelling` (`:317`). On the host, if the paused run's prior spawn already drove the host-side `AgentRun` out of `paused` (e.g. `onSpawnExit` ran when claude.exe exited clean at the pause point, or a snapshot mismatch), the answer is dropped with NO error returned to the server (the host returns `ok` with a stale snapshot at `agent-host-service.ts:362-369`).
2. Even when it proceeds, `runSpawnPhase('resume', answer)` re-spawns and `await spawn.send(answer)` rides `sendBracketedPaste` — which is OBJ-3's defect: on `echo-timeout` it returns without `\r`, so the answer is pasted but never submitted; `runSpawnPhase` then flips `send-failed` terminal (`agent-run.ts:433`) ONLY if the result is non-`ok`, but if the echo matched and the protocol returned `ok` while the submit `\r` never effectively reached claude.exe, the turn is stranded and the run sits running until the idle sweep.

Build-session investigation requirement (cannot be pinned to one line from static read alone): in the live host stack, confirm the host-side `AgentRun.state` at the moment `answer-pending` arrives (add a one-line host log of `entry.run.getState()` in `answerPending` before `_resumeWithAnswer`, behind a debug flag, REMOVE before commit). Then fix the confirmed branch:
- If the host run is NOT `paused` when the answer arrives: the host must hold the paused `AgentRun` in `paused` across the claude.exe exit (the pause is JSONL-detector driven; ensure `_markPaused` ran and `onSpawnExit` does not drive a paused run terminal). The fix is to make `answerPending` return a typed error (not a stale-snapshot `ok`) when `_resumeWithAnswer` is a no-op, so the server's `answerPendingAsk` maps it to `resume-failed` instead of stranding `running`.
- If the host run IS `paused` and re-spawns but the send never submits: this is OBJ-3 — the echo-timeout composer-recovery fix (section 2 OBJ-3) covers it; the resume send then either submits or fails fast as `send-failed`.

Files/functions to touch (after the confirming trace):
- `packages/agent-host/src/agent-host-service.ts` — `answerPending` (`:352`): return a typed `not-resumable` error when `_resumeWithAnswer` did not transition the run (do not return a stale-snapshot `ok`).
- `apps/server/src/services/pause-resume.ts` — `answerPendingAsk` (`:251`): map a host `not-resumable` response onto the existing `cause:'resume-failed'` return (`:351`) so the durable layer finalizes the run rather than leaving it `running`. The atomic flip + facts already exist; only the host-resume-send result handling changes.
- Possibly `packages/runtime/src/agent-run.ts` — `_resumeWithAnswer` (`:315`) / `onSpawnExit`: only if the trace shows a paused host run is driven out of `paused` by its own spawn exit. Keep minimal; do NOT refactor the lifecycle.

### OBJECTIVE 3 — slice-006 echo-timeout composer recovery (gluing root)

`sendBracketedPaste` (`send-protocol.ts:177`) writes the bracketed paste `\x1b[200~<body>\x1b[201~` (`:189`), polls for an echo, and on timeout RETURNS `'echo-timeout'` at `:201` WITHOUT writing `\r`. The body sits un-submitted in claude.exe's composer; the next send's paste lands on the same composer line -> `testingOKay` gluing and corrupted text correlation. The queue self-heals (`1f9f4262`) but the composer is left dirty.

Chosen fix: on the echo-timeout path, before returning `'echo-timeout'`, CLEAR the un-submitted body from the composer rather than blind-submitting it (submitting unverified text is the anti-criteria the protocol was built to avoid). Write a composer-clear sequence — `\x15` (Ctrl-U, kill-line) is the minimal clear; `\x1b` (Escape, already used by `LowLevelSpawn.interrupt()` at `low-level-spawn.ts:314`) is the existing precedent for a graceful composer reset. Recommend Ctrl-U (kill the typed line) so a partially-pasted body cannot survive into the next send; do not write `\r` (never submit unverified). Keep the `'echo-timeout'` return value so callers still treat the send as failed. The decision (Ctrl-U vs Escape) is an Open Question (section 13) — confirm before building.

Files/functions to touch:
- `packages/runtime/src/send-protocol.ts` — `sendBracketedPaste` (`:177`), the `return 'echo-timeout'` path at `:201`: write the composer-clear sequence to `deps.write` before returning. Add a `SendDeps` clock-safe, no new dep (uses existing `deps.write`). Also confirm the early `exited` returns (`:182`, `:193`) need no clear (the PTY is gone).

This directly de-risks OBJ-2's resume send: a resume that echo-times-out now leaves a clean composer and fails fast as `send-failed` rather than gluing the answer onto a later turn.

## 3. In-scope / Out-of-scope

In-scope:
- OBJ-1 boot-order gate-wiring (the LEAD): construct mailbox bindings before the boot handlers; thread `deliveryRouter` + `mailboxEnqueue` into boot-reattach, reconcile sweep, and liveness sweep.
- OBJ-2 host resume-send fix: typed not-resumable host response + server mapping to `resume-failed`; minimal `_resumeWithAnswer`/`onSpawnExit` fix only if the trace confirms a paused-state loss.
- OBJ-3 echo-timeout composer recovery in `send-protocol.ts`.
- Tests: extend `agent-host-terminal-gate.test.ts` to the boot-handler paths; new/extended tests for the liveness-sweep port threading, the host resume-send result handling, and the `send-protocol` composer-clear.

Out-of-scope (DEFERRED — name the owning slice):
- The broader runtime-host INTERFACE extraction / transient-session adapter contract / worktree + path-guard boundary facade — DEFER to slice 011 cleanup (the pathway's nominal 009 wording). Not required by the three defects; a speculative refactor here would touch the live PTY/host surfaces with no behavioral payoff this slice.
- `004` workflow-run cancel surface + unwired `reconcileWorkflowRunsOnBoot` — slice 004 follow-up / 011.
- `005` `/agent-runs/{id}/cancel` 404 for host-backed runs (host-not-aware kill family) — related runtime-host hole, but a SEPARATE defect; DEFER unless the OBJ-2 trace shows it shares the exact fix (note it, do not pull it in).
- Channel deletion / `agent_inbox` removal / `compat-channel` wiring — slice 011.
- Mailbox-as-pending-interaction-authority (Q2) — its own slice after 009.
- Mailbox live-propagation intermittency (WS subsystem priority #1) — NOT this slice.
- Test-typecheck hygiene (`stash@{0}`, ~37 errors) — slice 011.
- No DB migration; no contract change expected (verify only).

## 4. Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified | Factory live host handler is gated (hotfix `e22456d2`). | `agent-run-factory.ts:606,689`; `agent-host-reattach.ts:272-317` forwards `deliveryRouter`/`mailboxEnqueue` |
| Verified | Boot reattach call omits the mailbox port. | `index.ts:371` |
| Verified | Reconcile sweep call omits the mailbox port. | `index.ts:413` (interval `:405`, 15s) |
| Verified | Liveness sweep call + `finalize` omit the mailbox port. | `index.ts:442`; `agent-run-liveness-sweep.ts:122,140` |
| Verified | `emitTerminalEnvelope` reads the gate (defaults `envDeliveryRouter()`) but defaults `mailboxEnqueue` to null. | `agent-run-terminal-effects.ts:189-206` |
| Verified | `deliverAgentEnvelope` needs BOTH gate=mailbox AND a non-null port; else falls through to Channel `enqueueAndPush`. | `agent-delivery.ts:238,267` |
| Verified | `applyHostTerminalSnapshot` is idempotent on `agent_runs`; first applier wins the delivery. | `agent-run-terminal-effects.ts:81` |
| Verified | Mailbox bindings (`mailboxService`/`deliveryRouter`/`enqueueMailboxAndFanout`) declared AFTER the boot handlers -> direct boot-time ref is TDZ. | `index.ts:477,538,540` vs `:369-456` |
| Verified | Boot deps already accept `deliveryRouter`/`mailboxEnqueue`; only the call sites omit them. | `agent-host-reattach.ts:69,73`; `agent-run-server-boot.ts:27` |
| Verified | `ProjectRegistry` already references a later-declared delivery fn (`deliverWorkflowReview`) via a post-boot closure — precedent for lazy refs, but boot handlers run AT boot, not lazily. | `index.ts:276-281,552` |
| Verified | Host resume routes server->host `answer-pending` -> host `AgentRun._resumeWithAnswer` -> `runSpawnPhase('resume', answer)` -> `spawn.send`. | `agent-active-runs.ts:105`; `agent-host-service.ts:352,362`; `agent-run.ts:315,322,394,432` |
| Verified | `_resumeWithAnswer` silently no-ops if not `paused`/`cancelling`; host returns stale-snapshot `ok`. | `agent-run.ts:316-317`; `agent-host-service.ts:362-369` |
| Verified | `runSpawnPhase` sends the answer via `spawn.send` and flips `send-failed` only on non-`ok`. | `agent-run.ts:430-441` |
| Verified | `sendBracketedPaste` returns `echo-timeout` without `\r`, leaving the body in the composer. | `send-protocol.ts:189,201` |
| Verified | `\x1b` (Escape) is the existing graceful composer/stream interrupt. | `low-level-spawn.ts:312-314` |
| Verified | `buildSpawnInput` does NOT pass `initialInput` to the spawn; the body is delivered via `spawn.send` after the gate opens. | `agent-run.ts:456-465` |

## 5. Mechanism Decision for OBJ-1 (a vs b)

Chosen: **(a) construct the mailbox bindings before the boot handlers and pass them in directly.**

(a) construct earlier:
- Move the slice-007/008 mailbox-platform block (`mailboxService` `:477`, the `mailboxSendService`/`mailboxOrchestratorTurnAdapter`/`mailboxWorker` it composes, `deliveryRouter` `:538`, `enqueueMailboxAndFanout` `:540`) to just BEFORE the boot-reattach block at `:369`. All of `enqueueMailboxAndFanout`'s dependencies already exist by then: `broadcastTo`/`broadcastAll` (`:232`-ish), `buildLiveEventFrame` (imported), `MailboxService` (imported). The mailbox WORKER `setInterval` and the route registrations can stay where they are; only the value bindings the boot handlers need must move up.
- Then the boot calls pass `deliveryRouter` + `mailboxEnqueue: enqueueMailboxAndFanout` directly. No TDZ (the consts are initialized before the references).

(b) lazy port (deferred getter):
- Pass `mailboxEnqueue: (input) => enqueueMailboxAndFanout(input)` and `deliveryRouter` into the boot handlers; the arrow is only INVOKED at terminal-apply time (post-boot), so the `enqueueMailboxAndFanout` reference resolves lazily.
- This works for the 15s/30s sweeps (they fire post-boot). It does NOT cleanly work for the inline `await reattachAgentRunsDuringServerBoot(...)` at `:371`, which runs DURING boot and may apply a terminal synchronously inside the awaited call — at that instant `enqueueMailboxAndFanout`/`deliveryRouter` may still be in their TDZ if the closure is invoked before line 540 executes. A lazy getter only defers the *read*; if the boot reattach applies a host terminal before the module finishes initializing those consts, the getter throws.

TDZ justification for choosing (a): `mailboxService`/`deliveryRouter` are `const` and `enqueueMailboxAndFanout` is a `function` whose BODY closes over `mailboxService`. A `const` is in its temporal dead zone until its declaration executes. The boot reattach at `:371` is an inline `await` that can synchronously apply a host terminal envelope. If we keep the consts at `:477`/`:538`/`:540` and pass even a lazy closure, the closure invoked during that awaited boot call would touch consts not yet initialized -> runtime TDZ throw. Constructing the bindings BEFORE `:369` removes the hazard entirely and makes the data-flow obvious (no lazy indirection). (b) is the riskier option precisely because of the boot-reattach inline path. Decision: (a).

Constraint for (a): the move must not reorder anything the mailbox block itself depends on. Verify `broadcastTo`/`broadcastAll`/`broadcastSendQueueSnapshot`, `resolveProject`, `projectRegistry`, and `getMailboxMessage`/`getMailboxRecipient`/`parseMailboxAddress` are all available above `:369` (they are: registry `:268`, broadcasts in the runtime-host controller deps `:232`, repo/contract fns imported at top). `resolveProject` is defined at `:466` (a hoisted `function`) — it is referenced only inside `mailboxSendService`'s `getPort`/`ensurePort` closures which run at delivery time, so its later declaration is safe (function hoisting + lazy call). If any moved binding turns out to need a value not yet available above `:369`, STOP and reassess (it should not).

## 6. File-by-file Work Plan

```text
apps/server/src/index.ts
  - Relocate the mailbox-platform value bindings (mailboxService, mailboxSendService,
    mailboxOrchestratorTurnAdapter, mailboxWorker, deliveryRouter, enqueueMailboxAndFanout)
    to immediately BEFORE the boot-reattach block (currently :369). Keep registerMailboxRoutes /
    the worker setInterval / boot-sweep where they are (they can stay post-relocation).
  - :371 reattachAgentRunsDuringServerBoot({ broadcast, channelServer, deliveryRouter,
    mailboxEnqueue: enqueueMailboxAndFanout }).
  - :413 reconcileAgentRunsAgainstHost({ hostClient, broadcast, channelServer, deliveryRouter,
    mailboxEnqueue: enqueueMailboxAndFanout }).
  - :442 sweepAgentRunLiveness({ activeRunRegistry, channelServer, broadcast, deliveryRouter,
    mailboxEnqueue: enqueueMailboxAndFanout }).
  - NOTE: index.ts contains a stray NUL byte (Grep flags it "binary"); do not introduce
    encoding damage when editing — edit surgically, verify git diff --check.

apps/server/src/services/agent-run-liveness-sweep.ts
  - LivenessSweepDeps (:38): add deliveryRouter?: DeliveryRouter; mailboxEnqueue?: MailboxEnqueuePort | null.
  - finalize (:116-147): forward deps.deliveryRouter / deps.mailboxEnqueue into the
    applyAgentRunTerminalEffects deps (:140).

packages/agent-host/src/agent-host-service.ts
  - answerPending (:352): when entry.run._resumeWithAnswer(text) does not transition the run
    (run not paused / cancelling), return this.error('answer-pending','not-resumable', ...)
    instead of a stale-snapshot ok. Requires reading the run state before/after the call
    (AgentRun.getState()).

apps/server/src/services/pause-resume.ts
  - answerPendingAsk (:251): when the host path is in use and the host returns not-resumable,
    finalize via the existing commitAgentRunTerminal(:340) / return cause:'resume-failed'(:351)
    so the run does not strand running. (In-process unchanged.)
  - NOTE: the in-process resumeWithAnswer is fire-and-forget (void); host resume is a command
    response. If the server cannot observe the host not-resumable result through the current
    HostBackedActiveRunHandle.resumeWithAnswer (which is void, :105), this objective also needs
    resumeWithAnswer to surface the command outcome — see Open Questions / risk.

packages/runtime/src/agent-run.ts (ONLY if the OBJ-2 trace shows a paused host run loses paused)
  - _resumeWithAnswer (:315) / onSpawnExit: ensure a paused run is not driven terminal by its
    own prior spawn exit. Minimal; no lifecycle refactor.

packages/runtime/src/send-protocol.ts
  - sendBracketedPaste (:177), echo-timeout return (:201): write a composer-clear (Ctrl-U \x15,
    OR Escape \x1b) via deps.write before returning 'echo-timeout'. Do NOT write \r. Keep the
    'echo-timeout' return value.
```

## 7. Contract / DB / Live-Event Plan

- No `@pc/contracts` change expected. The host command protocol's error CODE set may need `'not-resumable'` added to `AgentHostCommandErrorCode` (verify the union in the agent-host contract; if adding a code, keep it additive). If a contract enum must change, note it but keep it minimal.
- No DB migration. No table altered. Slice 007 added every mailbox table; OBJ-1 only enqueues through the existing `enqueueMailboxAndFanout`.
- No new live-event family. OBJ-1 reuses the slice-007 `mailbox.message.changed` fanout already wired in `enqueueMailboxAndFanout` (`index.ts:540-546`). OBJ-2's `resume-failed` finalize rides the existing slice-005 `agent.run.changed` fact.

## 8. Tests to add / extend

Test files (note: `pnpm typecheck` EXCLUDES `test/**` per every package tsconfig — a green typecheck does NOT type-check tests; run them directly with tsx and type-check new test files via a temp `tsconfig.testcheck.json` then remove it):

| Priority | Test | Purpose |
|---|---|---|
| P0 | `apps/server/test/agent-host-terminal-gate.test.ts` (EXTEND) | New cases: boot-reattach, reconcile-sweep, and liveness-sweep terminal handlers, when gate=mailbox AND the port is wired, enqueue ONE mailbox message and write NO `agent_inbox` row; with the port omitted they fall back to Channel (documents the bug-before-fix). |
| P0 | `apps/server/test/agent-run-liveness-sweep.test.ts` (new or extend) | `finalize` forwards `deliveryRouter`/`mailboxEnqueue`; gate=mailbox -> mailbox enqueue, gate=channel -> Channel. |
| P0 | host resume-send result test (agent-host or pause-resume test) | Answering a paused host run that is NOT resumable returns `not-resumable` -> server maps to `resume-failed` and finalizes the run (no stranded `running`). A resumable host run threads the answer as the next user turn. |
| P0 | `packages/runtime/test/send-protocol.test.ts` (restore/extend; archive copy exists) | On echo-timeout, `sendBracketedPaste` writes the composer-clear (Ctrl-U/Escape) and NOT `\r`, and still returns `'echo-timeout'`; on `ok` it writes `\r`; `exited` paths write nothing. |
| P1 | boot-order integration (in-process) | Two host terminal handlers racing on the same run: the gate=mailbox path enqueues at most ONE mailbox message (idempotency key `agent:${runId}:${kind}`), never a Channel row. |

## 9. Verification Steps

Run from repo root. Do NOT trust subagent "gates green" reports or the IDE diagnostics feed mid/post-build — run these explicitly.

Typechecks + full:
```powershell
pnpm --filter @pc/contracts typecheck
pnpm --filter @pc/db typecheck
pnpm --filter @pc/app-services typecheck
pnpm --filter @pc/server typecheck
pnpm --filter @pc/web typecheck
pnpm --filter @pc/runtime typecheck
pnpm --filter @pc/agent-host typecheck
pnpm typecheck
git diff --check
```

Touched package tests (run directly; do NOT infer test-type coverage from `pnpm typecheck`):
```powershell
pnpm --filter @pc/server test
pnpm --filter @pc/runtime test
pnpm --filter @pc/agent-host test
pnpm --filter @pc/app-services test
```
Type-check the NEW/extended test files via a temporary per-package `tsconfig.testcheck.json` (include `test/`), then remove it — `pnpm typecheck` will not catch test-file type errors.

Gated browser checklist (human; requires a full `pnpm dev:app` RELAUNCH with the env set — the gates are env-only and a surgical restart reuses the old env; the build subagent does NOT restart anything):
- Clean relaunch: `PC_DELIVERY_AGENT=mailbox PC_DELIVERY_WORKFLOW_REVIEW=mailbox PC_DELIVERY_WEBHOOK=mailbox pnpm dev:app` (background).
- Dispatch a background agent from the orchestrator chat; let it complete.
- EXPECT: exactly ONE orchestrator turn arrives via mailbox (delivery `accepted`, a send-queue `target_ref`); NO new `agent_inbox` row for that run; NO Channel push. (This is the OBJ-1 pass.)
- Pause a host-backed agent (it asks), then answer it from the orchestrator: EXPECT the agent receives the answer as its next user turn and proceeds (OBJ-2 pass); a non-resumable answer finalizes the run to `failed`/`resume-failed`, never stranding `running`.
- Rapid-fire several discrete sends while Claude is busy: EXPECT no `testingOKay` gluing; an echo-timeout leaves a clean composer and does not corrupt the next send (OBJ-3 pass).
- Default (no env): re-confirm Channel behavior unchanged.

## 10. Migration Steps

1. OBJ-1: relocate the mailbox bindings above `:369`; pass `deliveryRouter` + `mailboxEnqueue` into the three boot handlers; thread the two deps through `agent-run-liveness-sweep.ts`. Extend the gate tests.
2. OBJ-3: add the composer-clear on echo-timeout in `send-protocol.ts`; restore/extend the send-protocol test. (Do OBJ-3 before OBJ-2 — it de-risks the resume send.)
3. OBJ-2: add the host debug trace, confirm the branch, then add the typed `not-resumable` host response + server `resume-failed` mapping (and the minimal `_resumeWithAnswer`/`onSpawnExit` fix only if the trace requires it). Remove the debug trace. Add the resume-send test.
4. Run all verification (section 9).
5. Update trackers; post the human in-app checklist.

## 11. Rollback Plan

- OBJ-1 is a wiring move + added args — revert by restoring the original construction order and dropping the two args; the gate then no-ops to Channel (today's behavior). The slice-008 default (`channel`) means an unset deploy is unaffected either way.
- OBJ-3 is a single added write on a failure path — revert by removing the composer-clear line.
- OBJ-2 is additive error-handling — revert by restoring the stale-snapshot `ok` and dropping the `resume-failed` mapping (returns to the known-stranded behavior).
- No DB migration; nothing to reverse. Channel, `agent_inbox`, `enqueueAndPush` untouched.

## 12. Stop Conditions

Stop and return to planning if implementation requires any of:
- Extracting a runtime-host interface / transient-session adapter / worktree-path-guard facade beyond the three defects (slice 011).
- A DB migration, table alter, or backfill.
- Deleting/ceasing to register Channel, `agent_inbox`, `enqueueAndPush`, `/channel/*`, the per-CC bridge, or `compat-channel` (slice 011).
- Changing the slice-006 `enqueueRuntimeTurn` signature or the slice-007 worker/adapter.
- Changing pause/answer/cancel STATE semantics or `pending_asks` (slice 005) — only the host resume-send RESULT handling changes.
- Renaming/adding MCP tools or routing tool families through the mailbox (slice 010).
- Pulling in the `/agent-runs/{id}/cancel` host-not-aware 404, the 004 cancel surface, or the unwired workflow boot-reconcile.
- Restarting/killing dev processes, or raw-sending to the PTY outside the established send protocol.
- Submitting unverified composer text (writing `\r` on echo-timeout) — the OBJ-3 fix CLEARS, never blind-submits.

## 13. Open Questions

| Question | Status |
|---|---|
| OBJ-3 composer-clear: Ctrl-U (`\x15`, kill-line) vs Escape (`\x1b`, existing interrupt precedent)? | Recommend Ctrl-U (kills the typed line so a partial paste cannot survive); Escape is the existing precedent for a graceful reset. Confirm before building. |
| OBJ-2: can the server observe the host `not-resumable` result through the current `HostBackedActiveRunHandle.resumeWithAnswer` (void, `agent-active-runs.ts:105`)? | UNRESOLVED FROM STATIC READ. `resumeWithAnswer` is `void` and `answerPendingAsk` calls it fire-and-forget (`pause-resume.ts:338`). Surfacing the host command outcome to map `resume-failed` may require `resumeWithAnswer` to return/await the command response, OR for the server to learn the failure via the reconcile/liveness sweep (which OBJ-1 now gates correctly). Decide: thread the result synchronously, or accept the sweep as the finalizer. NEEDS the live host trace to choose. |
| OBJ-2 exact branch (paused-state loss vs send-never-submits): static read cannot disambiguate; requires the live host `getState()` trace. | Confirm in the build session before coding the fix. |
| Adding `'not-resumable'` to the agent-host `AgentHostCommandErrorCode` union — additive contract change acceptable? | Recommend yes (additive). Confirm. |

## 14. Acceptance Criteria

- A gated mailbox relaunch + a real agent dispatch yields exactly ONE orchestrator mailbox turn and NO `agent_inbox` row (OBJ-1).
- All three boot-wired host-terminal handlers (boot-reattach, reconcile sweep, liveness sweep) carry the delivery gate + mailbox port; `agent-host-terminal-gate.test.ts` covers them.
- Answering a paused host-backed agent threads the answer as its next user turn; a non-resumable answer finalizes the run (never strands `running`) (OBJ-2).
- `sendBracketedPaste` on echo-timeout clears the composer and does not glue onto the next send; still returns `'echo-timeout'` (OBJ-3).
- No DB migration; Channel + slice-007 mailbox both remain in place.
- Touched-package tests + full `pnpm typecheck` green (tests run directly; test files type-checked via temp tsconfig).
- The broader runtime-host/transient-worktree split + the host-not-aware cancel family remain deferred (011 / separate).
- Tracker marks this build-slice artifact `planned`.
