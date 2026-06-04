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

**Slice 0 — shared-HTTP tools (FD-2 adoption).**
`/api/mcp` StreamableHTTP endpoint in apps/server · per-request toolContext from validated
headers+token (replaces env-at-spawn) · same handler chain as stdio (routes/audit/two-tier door
unchanged) · flip `renderPcMcpBaseline` to `{type:'http',url,headers}` · delete the stdio baseline
entry · re-run the FD-2 spike harness · live: orchestrator turn + modal + dispatched agent all
green on HTTP tools.
*Guard:* ONE-TOOL-TRANSPORT (no `command:'node'` pc-rig entry anywhere) + token-validation tests.

**Slice 1 — Engine persistent-interactive policy.**
Policy flags on AgentRunInput + start-run · timer exemptions · cap-exempt lane ·
`interrupt`/`resize` commands · turn-state in snapshots/events · `run-jsonl` carries replay meta ·
`transcriptPath` in snapshots. All host-fake tested; no Brain behavior change yet.
*Guard:* policy regression tests (persistent run never idle-killed; cap math ignores it).

**Slice 2 — the swap + delete.**
ProjectRuntime orchestrator spawn → host `start-run {policy}` · pty-handlers wiring rebound to
host events (send-queue correlation G8, status-enum remap, titles, summaries, replay persist,
FD-18 states) · WS send/interrupt/resize → host commands · reconciler re-dispatch-on-host-death
branch · ☠ DELETE InteractiveSession-orchestrator path + `ensurePty` spawn (banned-resurrection).
*Guard:* ONE-SPAWN-OWNER extends to the orchestrator names.

**Slice 3 — live acceptance gauntlet.**
Chat end-to-end (send/stream/interrupt/queued/title/reload-replay) · kill host mid-chat →
loading → auto-resume with history · API restart → reconnect+replay · agents dispatch normally
alongside · packaged-mode pass · spike harness green.

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
