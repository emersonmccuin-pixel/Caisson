# Next Session Handoff — refactor/auto-pathway

## LATEST SESSION (2026-05-31) — SLICE 009 CLOSED via OBJ-2A (host-resume now works end-to-end)
Live-traced the OBJ-2 host-resume path (the one open item) and found it **UNREACHABLE**: a fresh host-backed agent calling `pc_ask_user` was rejected `409 wrong-state` forever. Root cause = `recordExplicitPause` gated on the in-memory `HostBackedActiveRunHandle.snapshot.state`, which never advances to `running` live — only the 15s reconcile sweep updated the DB row, NOT the handle (textbook violation of the state-propagation ADR: a third projection read at a correctness gate, fed only by the unreliable event stream). The shipped OBJ-2 markPaused-await fix (7e2c511b) sat downstream of a gate that never opened.

**Fixed via new OBJ-2A** (plan `build-slices/009-runtime-host-transient-worktrees.md` §"OBJECTIVE 2A"; opus plan+build subagents, gates self-verified):
- Pause/resume gates (`recordExplicitPause`, `answerPendingAsk` in `pause-resume.ts`) now decide on the **reconciled DB row** (`getAgentRunRow`) + an optional **on-demand host `list-runs` level-read** (wired in `agent-runs/routes.ts`) that closes the early-ask race — NOT the in-memory handle. The handle keeps identity + command capability only (demoted from state authority).
- `reconcileAgentRunsAgainstHost` + `applyAgentHostEvent` run-state now re-seed a registered `HostBackedActiveRunHandle` (convenience; `index.ts` passes `activeRunRegistry` into the sweep).
- Factory init-order race closed (`agent-run-factory.ts`): a `run-state` fired during the start-run `await` is captured and replayed onto the handle after assignment.
- No DB migration, no contract change. Tests: `apps/server/test/agent-pause-resume.test.ts` + `agent-host-reattach.test.ts`. Gates self-run: full `pnpm typecheck` exit 0; `@pc/server` 81/81; `git diff --check` clean.
- **LIVE-VERIFIED on the UI** (gated stack reloaded via `/api/dev/restart`): orchestrator dispatched `researcher` → it called `pc_ask_user` → run `01KT05CWFVB684ME6WM1MHF9KY` reached `paused` (gate OPENED — the bug) → answered "marmalade" in chat → resumed → `completed` cleanly.

**Slice 009 = DONE** (OBJ-1/2/2A/3 all landed + verified). **Do NEXT: slice 010 (Areas)** — plan `build-slices/010-areas.md` exists, marked planned. Session-tracker row 35.

**Verified airtight this session:** OBJ-1 (agent→mailbox) confirmed live from the DB — the test run's completion + ask both landed in `mailbox_messages`, zero new `agent_inbox` rows; OBJ-3 (echo-timeout composer recovery) confirmed by the `send-protocol` unit test (`echo-ack never lands → double-Escape, NOT Enter`, runtime 13/13) AND a UI rapid-fire (ALPHA/BRAVO/CHARLIE → three discrete in-order `observed_in_jsonl` send-queue rows, no gluing). The `PC_DEBUG_HOST_RESUME` instrumentation has been REMOVED (the not-resumable typed-error logic stays).

**Still deferred (separate, NOT slice 009):** host-not-aware `/cancel` 404 for some runs (missing-handle, not fixed by 2A — `/kill`+`/inspect` already read the DB row). The broader runtime-host interface extraction + the full state-propagation outbox/`changes`/cursor build remain slice 011 / the ADR migration.

**Stack note:** the gated `pnpm dev:app` is LIVE on 4040/5173/8788 and was reloaded this session via `/api/dev/restart` (force, to clear 2 phantom stale registry entries) so it runs the OBJ-2A source. Don't blindly relaunch; check first. Never restart unasked.

---

## PRIOR SESSION (2026-05-31) — agent scoping + pc_ask_user universal + pc_list_agents fixed
Investigated the slice-009 OBJ-2 blocker ("haiku pod echoed instead of asking"). Root cause confirmed: there **is** a real user-created global pod named `haiku` (created 2026-05-23) and it genuinely **lacked `pc_ask_user`** in its kit — the prior handoff note was right; my first reframe was wrong. Three commits landed + live-verified against a reloaded gated stack:
- **`a05e2a24`** — (1) `pc_ask_user` added to `REQUIRED_AGENT_TOOLS` (`packages/domain/src/tool-catalog.ts`) so EVERY agent (incl. user-created pods that omit it) gets it force-merged at create/update/materialize. (2) **Orchestrator agent scoping**: new single-source policy in `@pc/db` — `isProjectDispatchable` + `listProjectVisibleAgents` (project-scope pods + built-in/stock globals ONLY; global user-created pods excluded — user must copy one in via Add agent). `{{AVAILABLE_AGENTS}}` (`pod-variable-renderers.ts`), the Agents-tab list route (`pod-routes.ts`), and `resolveAgentForDispatch` (`pods.ts`) all route through that one rule.
- **`f54f03a4`** — wired the previously-DEAD `GET /api/projects/:id/agents` route (the `pc_list_agents` live roster lookup, was 404 every time → orchestrator silently fell back to spawn config) through the same `listProjectVisibleAgents`. Now 200 + scoped.
- **Live-verified** (UI agent via Playwright, reloaded server): Agents tab + orchestrator both exclude `haiku`/custom globals; orchestrator live roster lookup now succeeds instead of 404-falling-back; built-ins + project pods present. Gates: typecheck green, `@pc/server` 72/72, `@pc/db` 23/23.

**This UNBLOCKS the slice-009 OBJ-2 live trace** (the only thing left to close slice 009): pc_ask_user is now universal AND we can dispatch stock pods, so a host-backed agent can be driven to pause→answer→resume. **Do NEXT:** dispatch a stock agent told to call `pc_ask_user` → it pauses → answer it → confirm it RESUMES + completes (not stranded `running`) → capture the `PC_DEBUG_HOST_RESUME` trace the gated stack emits. Then mark slice 009 implemented.

**Tier-1 verifier gap (the "complete despite no side-effect" finding) → addressed by planned slices 013/014** (`build-slices/013-agent-contracts-first-class.md` + `refactor plan docs/agent-contracts-and-deliverables.md`). It's a design gap, NOT a bug: `runVerificationOnTerminal` (`agent-verification.ts:163`) flips empty-AC contracts straight to `complete`/`passed` by design ("trust the agent's end-of-turn signal"), and there's no predicate that can assert a runtime side-effect (e.g. "pc_ask_user was called"). Don't hot-patch it — it's covered by 013/014.

**Stack note:** gated `pnpm dev:app` (PC_DELIVERY_*=mailbox, PC_DEBUG_HOST_RESUME=1) on 4040/5173/8788, reloaded twice this session via `POST /api/dev/restart` (exit-75 → supervisor respawn) so it runs the new source. Don't blindly relaunch; check first. Never restart unasked.

---

**Read this FIRST.** Updated 2026-05-31 (session: slice-009 live review + full channels feasibility investigation → decision: commit to the PTY-input message-inbox; channels not ready).

## DECISION (2026-05-31): PTY-input message inbox is the path; channels are NOT ready
We exhaustively investigated using Claude Code **channels** (`notifications/claude/channel`) as a keystroke-free delivery transport instead of typing into the PTY. **Conclusion: not viable for the fleet now → do NOT re-investigate.** Full evidence + the empirical spikes are in memory `reference_channel_input_not_viable_typing_is_path` (and the leaked CC source at `E:\Claude Code Projects\Personal\claude-code`). TL;DR: `-p`/SDK is API-billed from 2026-06-15; the cloud bridge is cloud-only; channels work on individual Max ONLY for Anthropic-allowlisted plugins, and a custom plugin needs `--dangerously-load-development-channels` (a consent dialog — auto-dismissable since we drive the PTY, but it's the "dangerous" research-preview flag) and the orchestrator treats channel content as UNTRUSTED DATA. Team accounts could use an org-allowlisted plugin (admin console), individual Max can't without an Anthropic partner listing. So: **keep typing into the PTY; harden it. The leaked CC source is the SPEC for doing the composer-clear/submit correctly.**

## Do NEXT session, in order — SLICE 009 FIX PASS (the PTY-typing last hop)
The mailbox + worker + send-queue + routing are BUILT and **verified live**. The fix pass is **DONE and LIVE-VERIFIED** for the delivery path; OBJ-2 deep recovery + a newly-found content-capture defect remain.

**THE BIG ONE — agent completions now actually surface (root cause was NOT the drain race).** Live DB trace (run `01KSZX3DF3`, then `01KSZYC61E`) showed: agent completes → mailbox `agent-terminal` message → drained ~1s after idle (drain fix WORKED) → but the `port.send` of the `[pc:agent-event …]` completion turn **echo-timed-out and was silently lost** (send-queue row `failed`, never retried; mailbox delivery already `accepted` so nothing retried it). Root cause, confirmed in leaked CC `PromptInput.tsx onTextPaste` + `history.ts`: **CC renders any bracketed paste over ~2 lines or 800 chars as a `[Pasted text #N +L lines]` REF placeholder** (expanded back to full content on Enter). Multi-line completion turns ALWAYS placeholder-ize, so our literal echo-ack probe never matched → guaranteed 5s timeout on every completion.
- **Fix C (the real fix) — `send-protocol.ts` `echoMatched`:** accept CC's `Pasted text #` placeholder in the post-send tail as proof the paste landed. **LIVE-VERIFIED:** new completion send-queue row `01KSZYCE1N` = `observed_in_jsonl`, `delivery_attempts=1` (vs the two pre-fix rows `failed / send returned echo-timeout`); the completion turn surfaced in the orchestrator chat unprompted (~20s). 
- **Fix A (retry insurance) — `send-service.ts` drain loop:** a mailbox-sourced (`mb:`) row that transiently echo-timeouts now re-queues + retries with backoff (cap `MAILBOX_RETRY_MAX_ATTEMPTS=3`, `MAILBOX_RETRY_BACKOFF_MS=1500`) instead of being lost. Unit-verified; not needed live (C made completions land first try) — pure defense.
- **Dropped "Fix B (settle-gate)"** — premised on a post-turn-timing hypothesis the trace disproved. It was the placeholder, not timing.

**Earlier fix-pass items (committed `c6f40a23`, now corroborated live):**
1. **OBJ-3 echo-timeout composer-clear → double-Escape** (`send-protocol.ts`). CC's Esc clear is a double-press (`useDoublePress` 800ms); a single `\x1b` only arms "Esc again to clear". Double-Escape empties the whole composer. Corroborated: after a failed completion send, rapid `alpha/bravo/charlie` landed as clean discrete turns (no gluing).
2. **Drain-on-idle race** → `enqueueRuntimeTurn` now drains when `state==='ready'` (mirrors `sendUserTurn`). Verified by trace: the completion row was drained ~1s after idle, never stranded.

3. **OBJ-2 host-resume → FIXED (root cause found in code; commit pending).** Root cause was NOT what the handoff guessed ("keep the host run paused across its spawn exit") — it's a **fire-and-forget race**: `recordExplicitPause` (pause-resume.ts) called `HostRunHandle.markPaused` which fired the `mark-paused` IPC fire-and-forget and returned, so the ask route responded and the agent ended its turn BEFORE the host paused. The host then tailed the `turn-end` and `toTerminal('completed')`'d the run (state still `running`) while mark-paused was in flight; the later answer no-op'd. Because `pc_ask_user` BLOCKS on the ask-route response, the deterministic fix is: **`markPaused` now AWAITs the host ack and `recordExplicitPause` awaits it** before returning — so the run is genuinely `paused` before the agent's turn ends. (`agent-active-runs.ts` markPaused async + applies the host response; `pause-resume.ts` recordExplicitPause async; route awaits.) Unit-verified (`agent-resume-result.test.ts`: recordExplicitPause doesn't resolve until the host pause acks). **Live verification BLOCKED:** couldn't get a pod to actually call `pc_ask_user` (the haiku pod echoed the instruction and completed without asking — likely lacks `pc_ask_user` in its kit or won't honor a tool-first directive). To live-verify: use/author a pod that reliably calls `pc_ask_user`.

**Content-capture (`Result: (no output)`) → FIXED.** NOT a capture bug: in the work-item-as-contract model the agent reports its deliverable INTO the work item (run `01KSZYC61E` → work item body "DONE", complete, verified) and completes via tool calls, so the free-text result is legitimately empty. Fix: when a completed contract dispatch has an empty free-text result, the completion envelope falls back to the work item's deliverable (body). `agent-run-terminal-effects.ts finishTerminalEffects`; test in `agent-host-terminal-gate.test.ts`. Server 72/72.

**NEW DEFERRED DEFECT (found while driving the pause test):** the tier-1 auto-verifier marked a contract **complete/passed even though the required side-effect never happened** (the agent never called `pc_ask_user`, just echoed the instruction). Verification gap — the auto-verifier doesn't confirm the actual side-effect occurred. Separate from delivery/pause; investigate the tier-1 predicate.

**Slice-009 live review status:** OBJ-1 ✅. OBJ-3 ✅ (double-Escape, corroborated). Drain race ✅ (verified by trace). **Fix C ✅ LIVE-VERIFIED.** Fix A ✅ unit-verified. **Content-capture ✅ (unit + DB-confirmed).** **OBJ-2 ✅ fixed + unit-verified (live blocked on a pc_ask_user-capable pod).** New: tier-1 verifier side-effect gap ⚠ deferred.

**Stack note:** gated `pnpm dev:app` (PC_DELIVERY_*=mailbox, PC_DEBUG_HOST_RESUME=1) is running on 4040/5173/8788, reloaded via `/api/dev/restart` (exit-75 → supervisor respawn) so it runs C+A from source. `@pc/runtime` + `@pc/app-services` are consumed as SOURCE (`main: ./src/*.ts`), so a dev restart picks up server-side changes — no rebuild. Don't blindly relaunch; check first. Never restart unasked.

5. **Q2 (mailbox replaces "Waiting on you") = its own slice AFTER 009.** See decisions below.

## Done this session (2026-05-31)
- **Full 001–008 checklist run via opus Playwright/API subagents.** Verdicts below.
- **Slice-008 hotfix `e22456d2`** — host agent completions now honor the mailbox gate (the cutover was silently no-op'ing to Channel for the dominant host path).
- **Slice-006 re-fix `1f9f4262`** — send queue self-heals the echo-timeout wedge (FIFO fallback when exact-text correlation misses).
- **Q1 decided + documented** — `refactor plan/mailbox-message-catalog.md` (one universal feed, UI-routed by `kind` later; no schema change).

## 001–008 review verdicts
- 001 Projects ✅ (defect: project restore has no UI/API path + misleading "restorable" copy; minor setState-in-render warning on archive)
- 002 Project live outbox ✅ (LIVE propagation)
- 003 Work items ✅ (LIVE; approve/reject + attachment-create ride the agent-contract flow, no board UI — expected)
- 004 Workflows ⚠️ (fire/progress/edit ✅ LIVE; **no run-level cancel surface** — killing the agent orphans the parent run; approve/reject untested = cost)
- 005 Agent runs ⚠️ (dispatch + reconnect ✅; **`/agent-runs/{id}/cancel` 404s for host-backed runs** — host-not-aware family; pause/answer not cheaply forced)
- 006 Chat/send queue ✅ after re-fix (reconnect + resume ✅; wedge fixed `1f9f4262`; coalesce-while-busy is by design; echo-timeout gluing root deferred → 009)
- 007 Mailbox ✅ (inbox renders, project + global messages, read/dismiss, pending-interaction shadow open→answered, dead-letter mechanism present; live push intermittent = known)
- 008 Cutover ⚠️ webhook→mailbox ✅; **agent→mailbox NOT working end-to-end** — hotfix `e22456d2` is necessary but the boot-wired host handlers (reattach/sweep/liveness) intercept terminals to Channel → needs the boot-order gate-wiring (slice-009 lead objective); workflow-review→mailbox untested = cost

## Process (see `definitive-session-pathway.md` → "How We Run This")
- Live in-session; Claude dispatches **subagents** for plan + build. **Planners AND builds run on opus** — set `model: "opus"` explicitly, never sonnet.
- Per slice: plan (subagent, docs) → build (subagent, in-scope code) → Claude posts a plain-English checklist → human browser-review. No automated verify sessions, no Workflow pipeline (the `orchestration/` docs are retired).
- Control plane = `refactor plan/refactor-session-tracker.md` (trust it, not any hardcoded number) + `refactor plan/refactor-tracker.md`.

## Where we are
Branch `refactor/auto-pathway`, HEAD ~ `fb70b1b5` (verify; trust the tracker). Slices **001–008 built**:
- 001 project foundation — verified ✅
- 002 project live outbox (durable `live_outbox` + replay) — verified ✅
- 003 work-items/stages/fields/attachments + mutation gateway — verified ✅
- 004 workflow def/run/review service — built (⚠ boot-reconcile never wired — see defects)
- 005 agent-run service (gateway, pause/answer/cancel, facts) — built (⚠ host-resume answer bug — defects)
- 006 conversation/send/replay + send-queue fixes (stable FIFO + echo-timeout recovery) — built, queue verified
- 007 mailbox platform (6 tables, migration `0036`, lease/retry/dead-letter worker, ask-shadow, inbox UI now mounted in Activity rail) — built; backend verified by Playwright; ⚠ live propagation flaky
- 008 Channel→mailbox cutover (3 per-flow env gates, default `channel` = byte-identical) — built

## Operational gotchas (LEARNED — don't relearn the hard way)
- **Subagent "gates green" reports AND the IDE diagnostics feed are both unreliable during/after a long build.** Every full `pnpm typecheck` this session came back **exit 0** even when diagnostics screamed `Cannot find name` / missing-export errors — they were stale mid-build snapshots. ALWAYS run `pnpm typecheck` yourself before believing either. Also independently re-run touched tests (a subagent's "53/0" hid a flaky test).
- **Test files are NOT typechecked** (every package `tsconfig` include = `src/**`). Type errors in `test/*.ts` pass the gate. A partial fix (wire `test/` in + fix ~37 accumulated `string`→`ULID` errors across 003/004/005/006/007 test files) is **stashed in `stash@{0}`** — deferred per user; finish it or fold into slice 011.
- **Closing the Caisson/Electron window kills the whole `dev:app` stack** (the launcher quits on window close, then leaves the server orphaned). Don't close the window mid-test; or launch electron standalone (`pnpm desktop:dev`) so closing it won't kill the server.
- **Delivery gates are env-only** (`PC_DELIVERY_AGENT` / `PC_DELIVERY_WORKFLOW_REVIEW` / `PC_DELIVERY_WEBHOOK` = `channel|mailbox`, default `channel`). No `.env` loading. Flipping them needs a **full `pnpm dev:app` relaunch with the env set** — the surgical `POST /api/dev/restart` re-uses the existing env. Server-side changes need a reload; web changes are Vite-HMR-live.
- **Stack state at handoff is messy** (orphaned server+vite from an env-gated launch, a standalone electron, dead `dev:app` coordinator). RECOMMENDED clean start: kill stragglers (supervisor/dev-app first, then whatever holds ports 4040/5173/8788, then `electron.exe ...PC-PTY-Chat`), confirm ports free, then relaunch gated:
  `PC_DELIVERY_AGENT=mailbox PC_DELIVERY_WORKFLOW_REVIEW=mailbox PC_DELIVERY_WEBHOOK=mailbox pnpm dev:app` (background). That gives a clean, fully-loaded, mailbox-gated stack for the full review (also picks up the slice-007-fix global-enqueue route + the inbox mount).
- Never restart servers/app except when explicitly testing; never call restart endpoints from a build subagent.

## Full checklist to run via agents (slices 001–008)
Two windows (A/B) for propagation. Gates = mailbox for the cutover items.

**001/002 — Projects:** create/rename/reorder/archive/restore/delete a project in A → propagates to B live; close B, change in A, reopen B → catches up; reconnect after offline → missed changes replay.

**003 — Work items:** create/edit-fields/move-stage/delete/restore a work item in A → shows in B; approve/verify + reject (note: these still ride the legacy path); change the stage list; add/delete an attachment.

**004 — Workflows:** fire a run → live status in B; progress through nodes; review step → prompt in B; approve + reject; cancel; edit a definition. (Interrupted-run boot-reconcile is the known-unwired gap — don't expect a relaunched mid-run workflow to self-resolve.)

**005 — Agent runs:** dispatch → queued→running→terminal in B; pause → both flip paused; cancel a paused run; reconnect replay. ⚠ Answering a paused **host-backed** agent strands it (known slice-009 bug — expected fail).

**006 — Chat/send queue:** rapid-fire several discrete sends while Claude is busy → stay separate + in order (no `testingOKay` glue), drain automatically when Claude finishes; an echo-timeout no longer wedges the queue; reconnect mid-turn → transcript catches up; resume a past session; cancel-queued / retry-failed.

**007/008 — Mailbox + cutover (gates = mailbox):**
- Inbox renders in the Activity rail; enqueue a project message → appears in the rendered inbox (both tabs); read/dismiss updates.
- Global inbox: enqueue via `POST /api/mailbox/messages` (project-less `user-inbox` recipient) → surfaces in `/api/mailbox`. (Needs the slice-007-fix server route — present after a clean relaunch.)
- Agent → mailbox: complete an agent → arrives as ONE orchestrator turn via mailbox (delivery `accepted`, no Channel push). (Needs a real dispatch + live orchestrator session — the part the test agent couldn't force; drive it via the orchestrator chat.)
- Workflow review → mailbox: orchestrator-review node's prompt arrives via mailbox; approve/reject works.
- Webhook → mailbox: `POST :8788/channel/<slug>/<source>` to a project with no child → lands durably in the inbox (no silent drop).
- Dead-letter: force a failing orchestrator-turn → `dead-lettered` with attempts/backoff.
- Pending-interaction shadow: AskUserQuestion → `pending_interactions` row `open`→`answered`; let one time out → `expired`.
- Default (no env): everything behaves exactly as before (Channel path) — confirm no regression.

## Known deferred defects (also in `refactor-session-tracker.md`)
- **Host-backed agent resume drops the answer** → slice 009.
- **Slice-008 agent→mailbox cutover not working end-to-end (CONFIRMED behaviorally 2026-05-31).** The boot-wired host-terminal handlers — boot-reattach (`index.ts:371`), the `reconcileAgentRunsAgainstHost` interval sweep (`413`), liveness-sweep (`442`) — run before `mailboxService`/`enqueueMailboxAndFanout` (`477`/`540`), carry NO port, and intercept LIVE host terminals to Channel (winning the idempotency race vs the factory's gated handler). NOT just recovery — this is the primary host-terminal path. Hotfix `e22456d2` is necessary but insufficient; the boot-order gate-wiring is the **slice-009 lead objective**.
- ~~**Slice-006 echo-timeout leaves an un-submitted body in the PTY composer**~~ — FIXED (slice-009 fix pass): double-Escape composer clear in `send-protocol.ts` echo-timeout branch (single Esc was a no-op clear; CC's Esc is a double-press). Automated gates green; **live re-test owed**.
- **004 workflow run has no cancel surface** — killing the sole agent orphans the parent run `running` (compounded by the unwired workflow boot-reconcile). One orphaned run `3VZ9W4EMJN8C` left by the review.
- **005 `/agent-runs/{id}/cancel` 404s for host-backed/workflow-spawned runs** (route checks only the in-process `activeRunRegistry`; `/kill` works but leaves host compute orphaned `processKilled:false`). Host-not-aware kill family → slice 009.
- **001 project restore has no UI or API path** despite the Archive dialog saying "restorable from Show archived" (misleading copy + missing feature; archived project recoverable only via DB edit). Minor: setState-in-render warning on project archive.
- **Workflow boot-reconcile never wired** (slice-004 gap; `reconcileWorkflowRunsOnBoot` imported in `index.ts` but never called).
- **Test files excluded from `pnpm typecheck`** → `stash@{0}` partial fix / slice 011.
- **Mailbox live propagation intermittent** — `mailbox.message.changed` WS frame (`fanoutMessage`/`broadcastTo` in `apps/server/src/features/mailbox/routes.ts`) doesn't reliably reach connected tabs; data is always correct on fetch/reload. This is the **priority-#1 "UI refresh / WebSocket / event propagation"** subsystem, not a mailbox-only bug — there's prior WS-staleness history on this shared events stream.
- **Mailbox inbox doesn't filter dismissed rows** (UX; the hook fetches the unfiltered project inbox).

## Open design questions — DECIDED 2026-05-31
1. **Mailbox as one universal feed, UI-routed by `kind` later — DECIDED YES, documented.** See `refactor plan/mailbox-message-catalog.md` (every `kind` + its eventual UI home; pure UI-layer routing on the durable catalog, no schema change).
2. **Mailbox replaces "Waiting on you" — DECIDED YES, as its own slice AFTER 009.** Making the mailbox the authority for pending-interactions (retire the in-memory `/api/ask` resolver + the old panel) touches the same ask/resume host boundary slice 009 formalizes, so sequence it post-009 (slot in the 010–011 range or a dedicated slice). `runtime-hook-ask` is the shadow today; this makes it authoritative.

## Then resume slices
After the 001–008 review + the design discussion: plan **009 runtime-host/transient-worktrees** (fixes host-resume), then **010 Areas** (project-scoped focus buckets — `build-slices/010-areas.md`, planned), then **011 MCP typed client**, then **012 compatibility cleanup** (retire Channel, finish the test-typecheck hygiene from `stash@{0}`, and fold in the mailbox-takeover items above if decided).
