# Step 4 scope — orchestrator → Engine (+ FD-2 shared-HTTP tools adoption)

**Date:** 2026-06-04 · **Branch:** `refactor/auto-pathway` · **Ledger row 6 / sequencing P6** ·
**Risk: HIGH** (the live chat surface moves homes)

## What this is, in plain English

Today the chat you talk to (the orchestrator) is a Claude process owned directly by the API
server. Every other Claude process (dispatched agents) is owned by the Engine (agent-host), which
got a supervisor, crash-respawn, reconnect, and one reconciler in Steps 1–3+7. This step moves the
orchestrator onto the Engine too, so there is ONE owner of every Claude process — and deletes the
server-side spawn path it leaves behind. The shared-HTTP tools cutover (FD-2, spike passed 6/6)
rides along because it makes the move simpler, not harder.

**What you get:** the chat survives crashes the same way agents do (host dies → supervisor
respawns → chat auto-resumes with history + a "Claude is loading" state instead of a dead pane),
and one fewer lifecycle machine to maintain. **What can break while we do it:** everything about
chat — send, stream, interrupt, queued messages, titles, reload-replay. Hence slices, each
independently shippable + live-verified.

---

## Trace verdict (3 traces + adversarial refute, 2026-06-04)

The Engine's run primitive is *close* but NOT "wiring only." Confirmed gaps (refuted the rosy
claim), each owned by a slice below:

| # | Gap | Evidence |
|---|-----|----------|
| G1 | No turn-level `ready⇌busy` state on AgentRun; chat send-queue drains on `state→ready` | `interactive-session.ts:40` · `pty-handlers.ts:131` |
| G2 | No `interrupt` (Escape) host command — only destructive `cancel` | `agent-host-protocol.ts:76-94` |
| G3 | Idle 300s / wall-clock 2h / first-turn watchdog would kill a persistent session; no off-switch | `agent-run.ts:166-174` |
| G4 | Registry admission: orchestrator would consume an agent slot / queue behind agents | `agent-run.ts:239` |
| G5 | Reconciler finalizes host-lost; orchestrator needs **re-dispatch `--resume` + FD-18 loading** instead | `agent-host-reattach.ts:38` |
| G6 | No `resize` host command (terminal-grade control) | protocol union |
| G7 | PC replay log (`jsonl-events.jsonl`) is written by the server-owned session; Engine ownership orphans replay/reconnect unless the server re-persists from host events (seq/cursor must ride the wire) | `pty-session.ts:290-318` |
| G8 | Send-queue echo-ack correlation (`observed_in_jsonl`, clientMessageId) must keep working over the host event stream | `orchestrator-send-queue-delivery.ts:143` |
| +12 | ask-reply routing · title/AI-title persist · post-turn summaries · send-queue status enum mapping (`busy/spawning` ≠ run states) · chat-bridges resolver identity · transcript view · dev-controls depth · FD-18 resume policy · statusline env · git-fence identity · replay seq synthesis · mcp-handshake (this one WORKS — host command exists) | refute report 2026-06-04 |

**FD-2 trace:** ONE mcp.json baseline writer feeds every spawn path
(`claude-runtime-bundle.ts:renderPcMcpBaseline:146`) → the transport cutover is one writer flip,
not five migrations. The Brain has NO HTTP MCP endpoint yet (`@modelcontextprotocol/sdk` v1.0.0 is
already a dep; `StreamableHTTPServerTransport` available). Spike quirks to honor: reconnect opens
TWO CC sessions (don't key state on one-session-per-process); identity headers are claimable →
needs a token.

---

## Decisions (made with rationale — flag disagreement before build)

1. **Slice 0 = tools transport FIRST, everything at once.** Build `/api/mcp` in the Brain; flip
   the ONE baseline writer; ALL sessions (orchestrator, modals, dispatched agents) move in one
   commit; the stdio `pc-rig` baseline entry dies same commit (one path). Rationale: verifies the
   new transport while session *ownership* is untouched — two risky changes never move together.
   Bonus: with tools living in the Brain, ask/pause plumbing stops caring where the session lives.
2. **Identity = headers + per-session bearer token.** The server mints a random token per session,
   bakes it into that session's mcp.json headers, validates on every request (constant-time), and
   resolves project/session/grants server-side from its own table — headers carry the *claim*, the
   token proves it. Kills the spoofing + cross-project-leak risks flagged by FD-2.
3. **Engine gains a `policy` on start-run:** `persistent-interactive` = no idle/wall-clock/
   first-turn timers (G3), cap-exempt admission lane (G4), `interrupt` + `resize` commands
   (G2/G6), turn-state (`ready⇌busy`) in run snapshots + events (G1). Dispatched agents keep
   today's defaults — one primitive, policy flags, exactly the north-star §4 shape.
4. **Replay log: the server re-persists from host events** (G7). The wire `run-jsonl` envelope
   grows the replay meta (seq/cursor/kind/source). One replay-log writer, server-side, fed by the
   one host stream — same file, same route, UI untouched.
5. **Host death ≠ chat death** (G5). The reconciler's host-lost sweep gains a policy branch:
   `persistent-interactive` runs are NEVER finalized — re-dispatch with `--resume` on the fresh
   host + broadcast FD-18 `loading` to the UI. Paused-survives law untouched.
6. **Transcript debug view: no new protocol.** Host + server share a disk; run snapshots expose
   `transcriptPath`; the server tails the file directly. Dev-controls accept reduced spawn-attempt
   detail initially (logged, not built).
7. **Modals stay on PtySession** until P7 deletes them (sentenced by FD-21 — migrating them would
   be building on death row). The orchestrator's InteractiveSession path is DELETED in Slice 2,
   same commit as the swap; banned-resurrection gate grows the names.

---

## Slices (each shippable + live-verified before the next)

**Slice 0 — shared-HTTP tools (FD-2 adoption). ✅ SHIPPED + LIVE-VERIFIED 2026-06-04 (06097bf4).**
`/api/mcp` StreamableHTTP endpoint (impl in `@pc/mcp/http-endpoint`, mounted via raw-socket
bridge + `RESPONSE_ALREADY_SENT`) · identity = X-PC-* claim headers + HMAC token
(`mcp-http-auth.ts`, secret persisted under data/ so tokens survive API restarts; verified per
request) · JSON-RPC `initialized` routes through `createMcpHandshakeRouter` (one impl behind the
new door AND the legacy POST) · baseline flipped, identity threaded from all five spawn owners ·
☠ stdio transport in `@pc/mcp` server.ts (data exports stay) + `applyNodeLauncher`/
`mcp-config-rewrite.ts` + stdio bundle staging + heartbeat-file mcp-status (route answers live).
*Live:* dispatched agent fire→handshake→`pc_submit_deliverable` over HTTP→gate→approve→completed ·
fresh orchestrator spawn→handshake-gated ready→`pc_list_work_items` over HTTP→clean turn-end
(throwaway project, FD-16 recipe — note: first WS `send` is the spawn trigger, don't wait for
ready). Modals not separately live-fired (same one writer + weaker gate; covered by transport
tests). *Guards:* ONE-TOOL-TRANSPORT gate (HTTP entry asserted, stdio rejected, static
StdioServerTransport check) · auth round-trip/tamper tests · real HTTP boot smoke
(initialize→initialized→tools/list registry order · 401 forged token · -32001 unknown session).
Suites: server 240 · mcp 75 · workspace green.

**Slice 1 — Engine persistent-interactive policy. ✅ SHIPPED 2026-06-04 (bb2975fc).**
`policy: 'persistent-interactive'` on AgentRunInput + start-run request · G3 timer
exemptions (idle/wall-clock/first-turn never armed; spawn-stuck + handshake/ready stay —
a chat that can't spawn still fails fast) · G4 `AgentRunRegistry.exempt()` (born admitted,
holds no slot, release/abort never touch slot math) · G2/G6 `interrupt` (Escape,
non-destructive) + `resize` host commands, validator cases added in agent-host-client
(set-config burn class) · G1 turn-state `ready⇌busy` on record + snapshots, `turn-state`
event refreshes the run-state stream; **reattach reports `ready`** (busy-with-no-coming-
turn-end would deadlock the send-queue; a mid-turn send queues in CC — a feature) ·
G7 `run-jsonl` grows `cursor`/`kind`/`source` (AgentRun re-emits the tailer's
JsonlEventMeta instead of dropping it) · `transcriptPath` was already on the snapshot —
Slice 2 just threads it at start-run. Dispatched-worker defaults pinned by tests.
*Guards:* agent-run-policy.test.ts (9: never idle/wall-clock-killed, cap-exempt math,
interrupt/resize forward, turn-state transitions, meta re-emit) + registry exempt (2) +
persistent-interactive.test.ts (6: policy threading, command routing, wire meta,
turn-state snapshots). Suites: runtime 44 · agent-host 11 · server 240 · typecheck green.
No live-fire — nothing starts a persistent run until Slice 2 (its swap gauntlet is the
live gate). ⚠️ Flake seen twice then gone: `tsx --test` subprocess teardown crash
0xC0000409 on Windows; tests pass direct-run and on re-run — infra, not product.

**Slice 2 — the swap + delete. ✅ SHIPPED + LIVE-VERIFIED 2026-06-04 (9ebc2c9a + fix 215b4dc3).**
`OrchestratorHostSession` (apps/server/src/services/) presents the EXACT InteractiveSession
port+events surface, backed by host `start-run {policy:'persistent-interactive'}` — NO consumer
rewiring needed (pty-handlers/send-queue/titles/summaries/conversation-send all untouched).
Protocol grew start-run spawn shaping (mode/jsonlStartLine/envOverrides/model/requireReadySignal/
requireMcpHandshake/cols/rows) + `write-raw` command (terminal-mode keystrokes). Adapter survival
contracts: **ADOPT** a still-live host run after an API restart (roster match on ccSessionId — no
double-spawn) · **host respawn → FD-18 'spawning' + self-re-dispatch `--resume`** past the replay
cursor · replay log re-persisted server-side from run-jsonl wire meta · 'raw' terminal view =
transcript-file tail (decision 6) · kill→cancel + `settled`-on-host-terminal (successor awaits it;
cancelGraceMs 500 for chat). ☠ interactive-session.ts DELETED; banned-resurrection gate +=
'InteractiveSession' (caught its first offender — a doc comment — on first run).
**DEVIATION from decision 5, deliberate:** no reconciler policy branch — the chat has NO
agent_runs row, so the reconciler can't touch it; G5 recovery lives in the adapter.
*Live gauntlet (dev stack):* send→spawn→busy/ready→turn-end+reply ✓ queued-ack→delivered→
jsonl-user correlation ✓ title+cursor persist ✓ API restart→ADOPT (CC tools session re-opened,
same cc id) ✓ **host kill mid-chat → supervisor respawn → adapter self-re-dispatched (log:
"host changed — re-dispatching chat") → next reply quoted the pre-kill string exactly — full
history survived** ✓. *Live-fire bug found+fixed (215b4dc3):* one provider row → usage+turn-end
SHARING a source cursor; a live-advancing dedup threshold ate the turn-end (reply text never
rendered). Fix: dedup floor frozen at construct; + a close()d adapter stops writing the replay
file. Suites: server 251 · runtime 44 · agent-host 12 · typecheck green.

**Slice 3 — live acceptance gauntlet. MOSTLY COVERED by Slice 2's live-fire; remainder below.**
✅ already verified live: chat send/stream/queued/title · kill host mid-chat → loading →
auto-resume with history · API restart → adopt.
✅ **interrupt live-fired 2026-06-04 — found + fixed a wedge bug.** CC (2.1.162) writes NOTHING
to the JSONL on an interrupted turn (no assistant row, no turn boundary — empirically: 232s of
silence vs a 39s baseline reply), so G1's jsonl-turn-end→ready never fired: the chat stuck
'busy' forever and the send-queue deadlocked. Fix: `AgentRun.interrupt()` reports
turn-state 'ready' after Escape — the reattach rationale verbatim (a send into a still-streaming
CC queues safely; busy-with-no-coming-turn-end deadlocks). Adapter needed nothing: its
busy→ready snapshot edge already emits 'turn-end'. Live: interrupt→turn-end **5ms**,
follow-up delivered immediately, replied in 8s. Quirk noted: CC *may* late-finalize an
interrupted turn (~270ms, empty usage+turn-end) — harmless ready-flap, handled by the same
idempotent edge. +1 runtime guard test (45).
✅ **agents-alongside live-fired 2026-06-04 — PASS, full gauntlet in caisson:** chat reply →
fire file-then-review → chat replied DURING the worker run → gate paused → approve →
completed → chat replied after. Bonus proof: the mailbox injected the gate notification into
the orchestrator mid-test; the queued user send held behind the injected turn and drained
cleanly — chat + worker + system injections coexist on the one Engine.
✅ **spike harness 6/6 2026-06-04** — after fixing the harness's concurrency check: it
required all THREE 2s slow-windows to share one instant (client thinking-time luck); a 5/6
"fail" had a real 219ms A∩C overlap on the books. Now ANY pairwise overlap = the
non-serialization proof. Green run observed A∩C + B∩C genuinely simultaneous.
✅ **Sessions flows live-fired 2026-06-04 — PASS 7/7 (server-side; tab UI rides Emerson's
visual pass):** teach token → close (run exits, launcher state) → resume same session
(`--resume`; token recalled — history survives) → new session (fresh context, no leak;
NO-SECRET) → sessions list keeps both rows. Resume turn replied 6s after the resume POST.
✅ **packaged-mode pass 2026-06-04** (`dist:dir` build of dfc39b10+, win-unpacked on :4070,
scratch data dir, bundled CC = the pin 2.1.160 `pinnedMatch:true`): interrupt gauntlet PASS
(turn-end 13ms, follow-up replied) · sessions flows PASS 7/7 (close/resume-with-history/
new-session-clean/list) · graceful quit zero orphans. One-off: the FIRST packaged instance
died mid-smoke via a graceful `SIGINT — forwarding to 2 children` shutdown — **confirmed:
Emerson closed the window.** Not a bug; the graceful path did its job.
✅ **Emerson visual pass 2026-06-04: "everything looks good"** — reload-replay, Stop button,
Sessions-tab flows confirmed in-app. **Slice 3 CLOSED → Step 4 COMPLETE.**

## Open questions (carried, not blocking Slice 0)

- ask-reply / pending-ask routing detail for an Engine-owned orchestrator (likely simplified by
  Slice 0 — tools execute in the Brain; verify, don't assume).
- Git-fence identity for the orchestrator-as-Engine-run (control-plane; revisit w/ FD-5 worktree
  lifecycle design).
- Dev-controls diagnostic depth (accepted reduced; extend host snapshots if it bites).

## Sequencing note

Slice 0 has no dependency on Slices 1–2 and de-risks them; it is also the FD-2 adoption the
sequencing doc promised would "ride P6." If P6 stalls after Slice 0, the transport win stands
alone.
