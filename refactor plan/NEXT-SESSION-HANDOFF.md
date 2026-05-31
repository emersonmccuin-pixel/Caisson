# Next Session Handoff — refactor/auto-pathway

**Read this FIRST.** Updated 2026-05-31 (session: slice 009 PLANNED + BUILT — sessions 32/33).

## Do this session, in order — SLICE 009 HUMAN REVIEW (session 34)
Slice 009 is built (plan `refactor plan/build-slices/009-runtime-host-transient-worktrees.md`; plan + build commits on `refactor/auto-pathway`). It centers the three confirmed defects; the broader runtime-host/transient-worktree interface split is DEFERRED to 011. **The review REQUIRES a gated relaunch** (the agent gate is env-only; a surgical restart reuses the old env):

1. **OBJ-1 (LEAD) — agent→mailbox boot-order.** Clean relaunch `PC_DELIVERY_AGENT=mailbox PC_DELIVERY_WORKFLOW_REVIEW=mailbox PC_DELIVERY_WEBHOOK=mailbox PC_DEBUG_HOST_RESUME=1 pnpm dev:app`. Dispatch a real agent from the orchestrator chat; let it complete. EXPECT exactly ONE orchestrator turn via mailbox (delivery `accepted`, a send-queue `target_ref`), and NO new `agent_inbox` row for that run. The fix relocated the six mailbox value bindings above the boot handlers in `index.ts` and threaded `deliveryRouter`+`mailboxEnqueue` into boot-reattach (`:371`)/reconcile-sweep (`:413`)/liveness-sweep (`:442`) (the boot deps already accepted the params; only the call sites omitted them). Mechanism (a) was chosen over a lazy ref because the inline-`await` boot reattach can apply a terminal synchronously → a lazy closure would hit the `const` TDZ.
2. **OBJ-2 — host resume.** Pause a host-backed agent (it asks), answer from the orchestrator. EXPECT the answer threads as the next user turn; a non-resumable answer finalizes the run (`resume-failed`/`failed`), never stranding `running`. The defensive finalize is built; the DEEP paused-state-loss recovery is DEFERRED pending a live trace — with `PC_DEBUG_HOST_RESUME=1` set, **capture the host `[agent-host] answer-pending … stateBefore/stateAfter` logs** to confirm the branch (see `agent-host-service.ts` `// SLICE-009 OBJ-2` comment). That trace feeds the deep fix.
3. **OBJ-3 — echo-timeout composer.** Rapid-fire several discrete sends while Claude is busy. EXPECT no `testingOKay` gluing; an echo-timeout now clears the composer (Escape) and does not corrupt the next send. (`send-protocol.ts` writes `\x1b` not `\r` on echo-timeout.)
4. **Default (no env):** re-confirm Channel behavior unchanged.
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
- **Slice-006 echo-timeout leaves an un-submitted body in the PTY composer** (`send-protocol.ts` returns without `\r`) — the gluing root. The queue now self-heals (`1f9f4262`); the composer recovery is fenced-off protocol work → slice 009.
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
After the 001–008 review + the design discussion: plan **009 runtime-host/transient-worktrees** (fixes host-resume), then **010 MCP typed client**, then **011 compatibility cleanup** (retire Channel, finish the test-typecheck hygiene from `stash@{0}`, and fold in the mailbox-takeover items above if decided).
