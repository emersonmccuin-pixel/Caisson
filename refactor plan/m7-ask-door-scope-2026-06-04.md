# M7 — One ask door (FD-6) · scope · 2026-06-04

**Goal:** `pc_ask_user` dies. Agents ask ONE door — `pc_ask_orchestrator` — and the orchestrator
triages: answer from project context, or take it to the human in chat and relay. Baseline-tools
audit rides (FD-6 ripple: the required set changes).

## Trace findings (what exists today)

- `pc_ask_user` and `pc_ask_orchestrator` are **already one machinery**: same MCP handler case
  (packages/mcp/src/tools/agent-runs.ts:281), same route
  (`POST /agent-pending-asks`), same `recordExplicitPause`/`answerPendingAsk` state machine, same
  `pending_asks` table — differ only by `kind: 'user' | 'orchestrator'` and the mailbox event kind
  (`agent-asks-user` vs `agent-asks-orchestrator`).
- The "user" path is ALREADY orchestrator-as-proxy: the envelope goes to the orchestrator, whose
  prompt says "don't answer on the user's behalf." Deleting the tool deletes the *force-relay*
  instruction, not a separate pipe.
- Grants: 7 stock pods list it explicitly (researcher · writer · reviewer · planner · code-writer ·
  extractor · caisson) + `REQUIRED_AGENT_TOOLS` force-merges it into EVERY pod
  (tool-catalog.ts:148).
- AC derivation special-case: `/ask_user/` regex adds `pending_ask_created` predicate
  (ac-derivation.ts:139).

## Refute findings

- 🟢 **DB is empty of user-asks**: dev DB has ZERO `kind='user'` rows ever (3 orchestrator asks,
  all answered). No legacy-data migration needed; repo reads stay generic on `kind`.
- 🟢 "host-resume depends on pc_ask_user" (tool-catalog.ts comment) is **stale rationale** — the
  resume path is kind-generic; nothing checks `kind === 'user'`.
- 🟢 `pc_request_approval` shares the plumbing but is NOT sentenced — formal approvals are FD-7
  territory; it **survives M7 untouched** and gets re-homed by M8 Human Inbox.
- 🟢 `answeredBy: 'orchestrator' | 'user'` on `pc_answer_pending` **survives** — after M7 it's the
  audit trail of the 3-layer model (orchestrator answered itself vs relayed the human's words).

## Decisions

1. **`PendingAskKind` narrows** `'orchestrator' | 'user' | 'approval'` → `'orchestrator' | 'approval'`.
   Route validation rejects `kind:'user'` (typed 400). SQL untouched — old rows (dogfood) are
   historical, reads tolerate them.
2. **AC derivation broadens honestly**: the `/ask_user/` special-case becomes "any surviving ask
   tool that leaves a durable pending-ask row" (`pc_ask_orchestrator` · `pc_request_approval`) —
   they ALL write `pending_asks`; the predicate was always about the side-effect landing.
3. **`agent-asks-user` event kind dies** (contracts + AgentInboxEventKind + mailbox summary + web
   rendering). `agent-asks-orchestrator` + `agent-approval-request` survive.
4. **Prompt re-aim, not new mechanism**: `pc_ask_orchestrator` description + pod prompts tell
   agents to FLAG human-only questions in the question text; orchestrator prompt's handler entry:
   answer from context if you can, else ask the human in chat and `pc_answer_pending`
   (`answeredBy:'user'`).
5. **Baseline audit result**: required set = get_work_item · submit_deliverable ·
   ask_orchestrator · get_contract · list_attachments · get_attachment (6; was 7). One escalation
   door is the point.

## Slices

- **A — the deletion (code):** registry entry + tier row + REQUIRED_AGENT_TOOLS + MCP handler
  case + route validation + PendingAskKind narrow + domain types (AgentAsksUserPayload ·
  PcAskUserInput/Result · agent-asks-user kinds) + AC-derivation broaden + web rendering removal +
  tests updated + golden regen + banned-resurrection names.
- **B — grants + prompts:** 7 stock pod tool lists + prompt guidance rewritten (one door, flag
  human-only) + orchestrator playbook entry + boot reseed carries it to DB rows.
- **C — docs sweep + live gauntlet:** Sub-Systems tombstones (☠ FD-6) + sequencing/FD doc rows +
  live: dispatch agent with a human-only question → asks orchestrator → orchestrator surfaces in
  chat → answer relayed → run resumes → completes.

## ADDENDUM — live gauntlet caught a pre-existing resume bug (2/2 repro)

The one-door half is GREEN: agent (only door available) called `pc_ask_orchestrator`, flagged the
question human-only, options array rode the door, `pending_asks` row `kind:'orchestrator'`, run
paused, answer accepted (`answeredBy:'user'`), respawn issued. The `kind:'user'` POST returns the
typed 400.

Then 2/2 runs WEDGED at resume — NOT an M7 break (M7 deleted a label off this shared machinery;
the identical flow predates it):

1. **The answer send is eaten by the `--resume` replay repaint.** Evidence: `spawn.send` returned
   ok (echo-ack matched the PTY echo during typing), but the JSONL census shows NO user row after
   the resume preamble, and the ANSI-stripped `transcript.log` ends at an EMPTY composer after the
   replay rendering. CC discards input typed before its post-resume quiet window
   ([[resume-needs-quiet-window]], lab-isolated 2026-05-22: needs ≥1500ms stdout quiet). Fresh
   spawns win this race (short banner); resume replays a transcript after the MCP handshake →
   ready fires early → send lands mid-repaint → eaten. Run sits 'running' forever (P9 ladder
   correctly badges + would notify at 5min — escalation worked as designed, nothing killed it).
2. **The pre-pause claude.exe NEVER exits.** `agent-run.ts` assumes "CC exits cleanly when paused"
   — interactive CC sits at the composer instead. `runSpawnPhase('resume')` replaces `this.spawn`
   without killing the old child → two claude.exe on ONE session id; `pc_kill_agent_run` kills
   only the current handle (`processKilled:false` left the original alive).

**Fix ✅ SHIPPED + LIVE-VERIFIED (cd92e784):** (a) `_resumeWithAnswer` kills the pre-pause spawn;
spawn event handlers identity-guarded so that kill's exit can't misfire `onSpawnExit`; (b) resume
send gated on `LowLevelSpawn.awaitOutputQuiet(1500ms)` (the lab-proven precondition); (c) positive
receipt — the answer's JSONL user row past the pre-send cursor floor (replayed historical rows
can't satisfy it), bounded re-sends (3) → typed `send-failed: resume-input-lost`. Silence never
wedges. 5 new tests (`agent-run-resume.test.ts`); runtime 46 · agent-host 12 · server 277 green.
**Third live fire end-to-end GREEN:** ask → answer → resume → agent echoed "Human chose:
fetch-report" → deliverable → `completed` w/ delivered_at; ZERO leftover claude.exe (runs 1+2 each
left a zombie). Reload ritual that worked: one-shot agent-host build (watcher gotcha) → kill host
pid (verify cmdline) → POST /api/dev/restart.

## Fire recipes (from P9/M5, verified)

- invoke: `POST /api/projects/01KS1358GYAQFG8BW9ERSB2J7C/agents/code-writer/invoke
  {input, dispatcherSessionId}` (caisson project)
- answer: `POST …/agent-pending-asks/:id/answer`
- tables: `agent_runs` / `pending_asks` (not *_v2)
