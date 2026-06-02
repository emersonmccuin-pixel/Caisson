# Agent subsystem — code analysis + first-principles rebuild plan (2026-06-02)

Source: read of the code only (no docs). Method: 1 lifecycle map per layer → synthesized lifecycle/state-machine → 6 bug-finders by lens → adversarial verify pass (25 confirmed, 15 rejected). Findings below are the confirmed, de-duplicated set.

---

## 1. What an agent run IS, and what is supposed to happen

Plain English: a "run" is one dispatched worker — a Claude Code CLI process doing one job (research, plan, write, review…). It is born from a request, runs out-of-process under a long-lived **host**, streams its work back, can pause to ask a question, and ends in completed / failed / cancelled. The server mirrors all of that into the database and pushes it live to the UI and back to the orchestrator that asked for it.

The full intended lifecycle, in order:

1. **Dispatch** — a route (`/agents/:name/invoke` or `…/continue`) calls `dispatchFreshAgent` / `dispatchContinueAgent`. It resolves the pod, mints a run id + session id, makes a scratch dir, inserts the `agent_runs` row at `queued`, and announces `queued` live.
2. **Contract resolution** — `resolveContractForDispatch` ALWAYS attaches a first-class contract (the verification spine). A work item is optional and only gets a roll-up at the end.
3. **Pod materialization** — writes the on-disk shape `claude.exe` consumes: the agent `.md` (prompt + tools + contract footer) and a filtered `mcp.json`.
4. **Run start** — `startHostBackedRun` subscribes to the host event stream, then sends `start-run` over the one `HostConnection`, validates the returned snapshot, registers a handle, mirrors status to the DB. (A no-host in-process path exists as a fallback.)
5. **Host constructs + spawns** — the host builds an `AgentRun` (cap-admitted), which spawns `claude.exe` via node-pty with `--agent --mcp-config --session-id`, auto-confirms trust prompts.
6. **Ready gate → running** — opens only when the MCP handshake + composer-ready + (orchestrator) init markers are all in; then the first user turn is sent with echo-ack.
7. **JSONL tailing + relay** — the run's output is read from Claude's on-disk JSONL transcript (NOT the PTY). Each event resets the idle timer; a turn-end completes the run. The host fans events into a 1000-entry ring buffer and serves them over `/events?after=seq`; the server's `HostConnection` holds one persistent subscription.
8. **Server applies + live propagation** — status → DB + `live_outbox` row; JSONL → `agent-jsonl-event` WS frame; terminal → terminal effects. A 250ms relay drains the outbox into `agent.run.changed` frames; the client identity-keyed live store renders cards.
9. **Pause / ask** — a `pc_ask_*` tool inserts a `pending_asks` row and **awaits** the host `mark-paused` before returning (so the host reaches `paused` before the turn ends — otherwise the answer is dropped).
10. **Resume** — an answer flips the ask to `answered` and awaits the host `answer-pending`; the host observes the state transition and returns `not-resumable` if the run didn't leave `paused`.
11. **Terminal determination** — turn-end → completed; timers (spawn-stuck / ready / idle / wall-clock / send-failed) or unexpected exit → failed; cancel → graceful; kill → force; host-lost → finalized by the reconcile sweep.
12. **Terminal effects + verification** — idempotent finalizer commits the terminal row + deliverable synchronously, then (async tail) runs verification and emits the `agent-completed/failed` envelope to the orchestrator's mailbox.
13. **Reattach after API restart** — the detached host + its PTYs survive; on boot the server reconnects, reconciles DB rows against `list-runs`, re-registers handles, backfills JSONL, resubscribes. It never respawns the agent.

### State machine (derived from code)
Statuses: `queued, spawning, running, paused, completed, failed, cancelled` (identical in `@pc/domain` and `@pc/runtime`). Terminal three are absorbing; idempotency is load-bearing because multiple terminal paths race (live terminal event, boot reconcile, host-lost sweep, hard-kill).

```
queued ──cap-admit──▶ spawning ──ready──▶ running ⇌ paused
  │                      │                 │  │
  └─cancel─▶ cancelled    └─stuck/ready─▶ failed │  └─resume─▶ spawning
                         turn-end / timers / exit ▼
                                  completed | failed | cancelled
```
No direct `queued → running` (spawning is always traversed). Wall-clock arms once and persists through paused.

### Load-bearing invariants
- Status flip bumps `rev`; `touchActivity` does NOT — the client dedups by `rev`, so a no-rev activity update can't refresh the UI by itself.
- A dispatch always mints a contract; verification keys on the contract, not the work item.
- Completion is decided SOLELY by a turn-end JSONL event while `running` — PTY stdout is only ready-gate + trust prompts + forensic log.
- Pause must reach host `paused` BEFORE the `pc_ask_*` tool returns.
- The host + PTYs must survive an API restart; reattach is reconnect, never respawn.

---

## 2. Bugs that keep it from working

Grouped by blast radius. "Run-loss" = a real agent the user dispatched silently dies or hangs forever.

### 🔴 Showstoppers

**S1 — Boot reconcile blanket-kills ALL live runs when the host is mid-respawn.** (`index.ts` boot path → `agent-run-boot-reconcile.ts`, critical)
On API boot the code does `await hostConnection.refreshRuns().catch(()=>{})` then reattaches against `listRuns()`. If the always-on host is restarting / TCP-refused at that instant, `listRuns()` returns the **empty cache**, and the host-branch reconcile marks every non-terminal row `host-lost` — i.e. kills every live run. The `!isConnected()` check only logs, and runs AFTER the kill. Directly violates "reattach must never destroy live runs." This is the single most damaging bug.

**S2 — Host respawn (new hostId) keeps the stale event watermark → live transcript frames are lost.** (`host-connection.ts` `doReconnect`, high)
A respawned host is a fresh process: its `seq` counter restarts at 0 and it mints a new `hostId`. On reconnect, `doReconnect` seeds the new client with the OLD high-water `lastSeq` (e.g. 5000) and never resets it on host-id change, so `/events?after=5000` returns nothing from a host whose events are seq 1..N. Every event the new host buffered before the API reconnected is dropped. Status converges via the sweep; live JSONL transcript frames are lost outright. Fix: reset `lastSeq = 0` when `endpoint.lock.hostId !== this.innerHostId`.

**S3 — Orchestrator never told its child finished if the notify tail throws.** (`agent-run-terminal-effects.ts`, high)
The terminal row + deliverable commit synchronously; verification AND the `agent-completed/failed` mailbox envelope run in a detached `void finishTerminalEffects(...).catch(log)`. There is no transactional coupling. If that tail throws (mailbox DB error, verification crash before the envelope) the run reads terminal forever but the orchestrator is never notified — and because the finalizer short-circuits on already-terminal, no sweep ever replays the envelope. The orchestrator waits forever. Ironic: the UI fact is durable (live_outbox), the orchestrator fact is not.

**S4 — Dead `/events` stream is never restarted while the host stays alive.** (`host-connection.ts` + `index.ts`, medium but high-frequency)
If only the ndjson stream drops (TCP reset, idle-socket reap, proxy timeout) but the host process lives on the same port: `HttpAgentHostClient.readEventStream` calls `reportProtocolError`, but (1) `index.ts` constructs the connection with **no** `onProtocolError`, and (2) `HostConnection` never subscribes to the inner client's `protocol-error`. The heartbeat only reconnects on lock-gone / host-id-change, and `sendCommand` against the live host succeeds — so nothing restarts the stream. Live frames go dark; only the 15s status sweep limps along and the transcript modal stops entirely. No keepalive ping on the stream either.

### 🟠 Reliability gaps

**R1 — Host-lost finalize only fires for `running`; `spawning`/`paused` runs hang forever under host loss.** (`agent-host-reattach.ts` `handleHostMissingRow`, high — found by 4 lenses)
`if (row.status !== 'running') { missingTicks.delete(row.id); return 0; }`. A host that dies mid-spawn or while a subagent is paused on an ask leaves that row non-terminal until the NEXT full server reboot (hours/days in a dogfood session). Host-backed runs have no server-side pid, and the in-process liveness sweep is gated OFF in host mode — so there is literally no continuous terminal path for spawning/paused under host loss. Especially bad in packaged mode, which doesn't respawn the host.

**R2 — Host dispatch fails the queued run on the first host-unavailable error with no bounded retry.** (`agent-run-factory.ts` `startHostBackedRun`/`failHostStart`, medium)
`sendCommand` reconnects exactly once; if the host is still mid-respawn (lock briefly absent) the dispatch finalizes the fresh row `failed: host-unavailable` and returns HTTP 200 `{ok:false}` — which no client retries. A run that would have started a second later is permanently lost.

**R3 — Agent-run routes never return 503/Retry-After; transient infra errors become un-retried 500s.** (`features/agent-runs/routes.ts`, medium)
The T2.1 `isTransient → 503/Retry-After` classifier is wired ONLY in `live-events/routes.ts`. None of invoke/continue/cancel/kill/deliverable/pending-asks/answer wrap their DB reads or host calls. A `SQLITE_BUSY` or host-blip in the ~1s restart window → a 500. The web client retries only on 503/network-throw, and the MCP retry only on 503/conn-throw — neither retries a 500. The whole cold-load resilience design is bypassed for the agent path.

**R4 — `refreshRuns()`/`listRuns()` return an empty cache silently when disconnected.** (`host-connection.ts`, medium)
Callers can't tell "no runs" from "host unreachable"; `ensureConnected` swallows connect failures with `.catch(()=>{})`. This swallow is what makes S1 fire. The heartbeat also never proactively re-establishes a persistent same-id `down` state — it only widens backoff.

**R5 — `answer-pending` not-resumable detection misses the transition-then-async-fail case.** (`agent-host-service.ts`, medium)
It only returns `not-resumable` when state is still `paused` after `_resumeWithAnswer`. But `_resumeWithAnswer` synchronously moves to `spawning` and runs the resume spawn fire-and-forget; if that spawn fails asynchronously the host already returned `ok` with a `spawning` snapshot. The server treats it as success; the run later fails — and if that terminal event is dropped, the running-only host-lost sweep (R1) won't finalize a `spawning` row.

**R6 — Live transcript frames are purged from the chat timeline on every WS reconnect / tab-focus.** (`chat-session-reducer.ts` + `AgentTranscriptModal.tsx`, medium)
The transcript modal is the one agent surface still reading off the raw, purgeable `events[]` array instead of the identity-keyed live store (the slice-018 pattern). `agent-jsonl-event` lands in the reducer's `unsequenced` bucket; the session-replay preserve allow-list keeps only `project.changed`, so every snapshot drops all buffered agent frames. Replay fires on reconnect AND on visibilitychange/focus/online — so tabbing away and back mid-run wipes the open transcript, which never re-backfills.

**R7 — `max_tokens` is treated as a clean completion.** (`agent-run.ts:803`, medium — analyst-added, not in the finder set)
`isTurnEnd` returns true for `stop_reason ∈ {end_turn, stop_sequence, max_tokens}`. A run truncated at the token ceiling is marked `completed` with a partial/empty result and passed to verification as if done. It should be a distinct failure (or trigger continuation), not success.

### 🟡 Cleanup / correctness debt (hide which path is real, corrupt diagnostics)

- **C1 — Double-subscribe.** Boot-global `onEvent` (runId-unfiltered) + per-run factory `onEvent` both apply every event; `run-jsonl` has no server-side dedup, so each transcript frame is broadcast twice (only client `stableTranscriptEventId` hides it). (`agent-host-reattach.ts` + `agent-run-factory.ts`)
- **C2 — Four disjoint, unmapped failure taxonomies:** persisted 16-value, mailbox payload 7-value, `SubagentFailureCause` 4-value, runtime `SubagentSpawnFailureCause` 6-value. Only persisted→payload has a (lossy) mapping; it never emits `loop-cap`/`depth-cap`/`unknown-agent` that the payload type + orchestrator prompt advertise.
- **C3 — Resume first-output failure mislabeled `idle-timeout`** (conflates a 90s resume failure with a 10-min idle; human description + payload mapping both wrong). (`agent-run.ts:645`)
- **C4 — `_markPaused` doesn't clear the first-turn watchdog** — a leaked (benign, running-guarded) timer escapes the "timers cleared on state change" invariant. (`agent-run.ts:300`)
- **C5 — Lock-file discovery trusts a stale pid+port** — only checks pid-aliveness, not that the pid IS the host or that the port is served; a SIGKILL'd host leaves a stale lock (only removed on graceful close) and pid recycling routes the conduit at a wrong port (self-heals via hello() failure, but actively returns a wrong endpoint). (`agent-host-lock-file.ts`)
- **C6 — Vestigial dead code:** `AgentRun.reattach`/`reattachLifecycle` reference a `HostClient.attachSpawn` attach-mode spawn that does not exist (production reattach is server-side reconnect); `subagent-spawner` detects `pc_complete_node({output})` but the canonical tool has no `output` field (payload always null); `PcInvokeAgentInput.wait` + `PcInvokeAgentResultSync` describe a sync mode no path implements; the `agent_inbox`/`agent_delivery_audit` layer is fully dead post-mailbox but schema/repos/enums remain.
- **C7 — `AgentRunDto.model` hardcoded to `'opus'`** in the route shims (no model column) — a sonnet/haiku pod is misreported. A constant lie, not data drift.
- **C8 — MCP 503 retry ignores `Retry-After`** (sleeps its own backoff; the rig's response type doesn't even carry headers) — diverges from the web client and can re-hammer the server.
- **C9 — Misleading "snake_case in, camelCase out" comment** on the expected_output path (the wire is camelCase both sides). Would mislead anyone adding a sibling field.

---

## 3. First-principles plan to build agents correctly

The architecture is sound (out-of-process host conduit, contract-first spine, identity-keyed live store, idempotent terminal finalizer). The bugs are not random — they cluster on **three structural weaknesses**. Fix the structure, not the symptoms.

### Root weakness A — terminal-determination truth is scattered with gaps
"Is this run still alive?" is answered by four uncoordinated mechanisms: per-run timers (on the host), boot reconcile (kills everything absent), continuous reconcile (running-only), in-process liveness (host-mode-off). Runs fall through the gaps (S1, R1, R5).

> **Principle 1 — one reconciler, all statuses, mode-agnostic.** A single per-tick authority decides each non-terminal row's fate from a priority of evidence: (a) host snapshot if the connection `isConnected()`; else (b) server-side pid liveness for in-process runs; else (c) host-authoritatively-absent + consecutive-tick guard → `host-lost` — **for every non-terminal status, not just `running`**. `spawning` and `paused` must have an in-flight terminal path. Boot reconcile becomes the same code with the same guards (never act on an unreachable/empty host). This kills S1 + R1 + R5's stranding tail in one move.

### Root weakness B — liveness/event delivery degrades silently
The conduit "self-heals on the next dispatch" but goes dark in between, and can't tell empty from unreachable (S2, S4, R4, C1).

> **Principle 2 — the event stream fails loud, and "unreachable" is a first-class value.**
> - Reset `lastSeq = 0` on host-id change before re-seeding (S2).
> - Wire `onProtocolError` → reconnect, and add a stream keepalive ping so idle-socket reaps are detected; route reconnect decisions through the existing `HostHealth` pill (S4).
> - `refreshRuns()` returns a discriminated `{connected, runs} | {unreachable}` — never a silent empty cache; the reconciler treats `unreachable` as "do nothing," not "all gone" (R4).
> - One subscription owner: the per-run factory handler should not co-exist with the boot-global handler applying the same events; pick one, dedup `run-jsonl` server-side (C1).

### Root weakness C — the orchestrator notification is best-effort with no replay
The UI fact is durable (live_outbox + relay); the orchestrator fact (the mailbox envelope) is a fire-and-forget tail (S3).

> **Principle 3 — make the orchestrator-notify as durable as the UI fact.** Write the `agent-completed/failed` envelope intent in the SAME transaction as the terminal row (or to the same outbox the relay drains), and have the reconciler replay an un-emitted envelope. The terminal finalizer stops short-circuiting purely on "row is terminal" — it short-circuits on "row is terminal AND orchestrator was notified." This closes the "orchestrator waits forever" hole structurally.

### Supporting principles

> **Principle 4 — retry the transient window everywhere a run can be lost.** Adopt 503/Retry-After on all agent-run routes (a global Hono `onError` + `isTransient` classifier) (R3); bounded retry on host dispatch across the respawn window before failing the queued row (R2); honor `Retry-After` in the MCP client (C8). The transient host-respawn window is a *normal* state, not a failure — never finalize a run because of it.

> **Principle 5 — one failure taxonomy.** Collapse the 4 enums to one canonical persisted set with explicit, lossless boundary mappings; stop advertising causes that are never produced (C2); give the resume-first-turn case its own cause (C3).

> **Principle 6 — completion correctness.** `max_tokens` is a truncation, not a success — make it a distinct terminal (or auto-continue), never a clean `completed` (R7). Move the transcript modal onto the identity-keyed live store like every other agent surface (R6).

> **Principle 7 — delete the dead paths.** Vestigial attach-mode reattach, `pc_complete_node({output})`, `wait`/sync dispatch mode, the `agent_inbox`/audit layer, the hardcoded `model: 'opus'`, the drift-twin lock-file shape (extract one shared module), the misleading comment (C5/C6/C7/C9). Dead code is why it's hard to tell which path is real — and it's a recurring source of the confusion that produced these bugs.

### Suggested sequence
1. **Stop the bleeding:** S1 (boot guard) + S2 (lastSeq reset) + S3 (durable notify) + S4 (stream restart). These are the run-loss + orchestrator-hang + dark-stream trio — small, surgical, highest value.
2. **Unify the reconciler (Principle 1):** fold boot + continuous + liveness into one mode-agnostic authority covering all statuses (absorbs R1, R5, R4).
3. **Resilience (Principle 4):** 503/Retry-After + bounded dispatch retry + MCP Retry-After.
4. **Correctness + cleanup:** R6, R7, then C-series (taxonomy, dead code, model, comments).

Items 1 are independently shippable today; item 2 is the structural payoff that prevents this class of bug recurring.
