# Next Session Handoff — refactor/auto-pathway

**Read this FIRST.** Written 2026-05-31 to resume with fresh context.

## Do this session, in order
1. **Run the full test checklist for ALL slices (001–008) via agents, BEFORE building more.** See "Full checklist" below. Drive the web UI at `http://127.0.0.1:5173` with the **Playwright MCP** (load `mcp__playwright__browser_*` via ToolSearch) + API/`curl` triggers, dispatched as **opus** verification subagents. Report pass/fail per slice. Two browser tabs for propagation checks.
2. **Discuss the two open design questions** (see "Open design questions").
3. **Then resume the pathway:** next is **slice 009 (runtime-host split)** — also fixes the logged host-resume bug. plan → build via opus subagents → human review.

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
- **Workflow boot-reconcile never wired** (slice-004 gap; `reconcileWorkflowRunsOnBoot` imported in `index.ts` but never called).
- **Test files excluded from `pnpm typecheck`** → `stash@{0}` partial fix / slice 011.
- **Mailbox live propagation intermittent** — `mailbox.message.changed` WS frame (`fanoutMessage`/`broadcastTo` in `apps/server/src/features/mailbox/routes.ts`) doesn't reliably reach connected tabs; data is always correct on fetch/reload. This is the **priority-#1 "UI refresh / WebSocket / event propagation"** subsystem, not a mailbox-only bug — there's prior WS-staleness history on this shared events stream.
- **Mailbox inbox doesn't filter dismissed rows** (UX; the hook fetches the unfiltered project inbox).
- **Global mailbox enqueue route** (`POST /api/mailbox/messages`) needs a server reload to be live (built in `fb70b1b5`).

## Open design questions (user raised 2026-05-31 — discuss + decide where they slot)
1. **Mailbox as one universal feed now, UI-routed by `kind` later.** Feasible & on-thesis: every message is durably catalogued with a `kind` + recipient/address. Route everything to one inbox now; later filter/subscribe by `kind` to dedicated surfaces (e.g. workflow human-review → a Review surface). Pure UI-layer routing on the durable catalog — no schema change. ACTION: write a short "mailbox message catalog" doc enumerating every `kind` and its eventual UI home.
2. **Mailbox replaces the "Waiting on you" subsystem.** Plausible & on-thesis (old subsystems → mailbox). "Waiting on you" = actionable mailbox items (pending-interactions + approval-needed). Today the pending-interaction is only a SHADOW (in-memory `/api/ask` resolver still authoritative). Full takeover = make the mailbox the authority, then retire the old panel = a dedicated migration slice. CANDIDATE for the 009–011 range or a new slice; decide sequencing.

## Then resume slices
After the 001–008 review + the design discussion: plan **009 runtime-host/transient-worktrees** (fixes host-resume), then **010 MCP typed client**, then **011 compatibility cleanup** (retire Channel, finish the test-typecheck hygiene from `stash@{0}`, and fold in the mailbox-takeover items above if decided).
