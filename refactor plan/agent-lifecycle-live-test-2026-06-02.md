# Agent lifecycle — live test + showstopper found (2026-06-02)

Live test of the agent subsystem after the S1–S4 showstopper fixes. Stack force-restarted, two opus test agents run against the live system. **Headline: the S1–S4 fixes hold, but a separate pre-existing bug means every agent run is marked `failed` 5 minutes after it actually succeeds.**

---

## TL;DR

- ✅ **S1–S4 fixes verified working live.** Host reachable + server connected, S4 `/events` keepalive observed (stream open full 35s), S1 boot path clean (no false kills, nothing stranded).
- 🔴 **Lifecycle is broken by a different bug.** A run that finishes in ~1s sits at `running`, then gets marked **`failed` (idle-timeout)** at exactly readyAt + 300s. The orchestrator is never notified. Hit a real orchestrator session's `researcher`+`caisson` runs too.
- **Root cause:** the host and the server disagree on `CLAUDE_CONFIG_DIR`, so the host watches the wrong transcript file and never sees the agent finish.
- **Not caused by S1–S4** — separate code (JSONL path / env), pre-existing.

---

## What was tested

- **Restart:** `scripts/restart-stack.ps1`. Result: server pid 41400 (ports 4040/8788), Vite 5173, host pid 25364 on ephemeral port 64015 (fresh hostId), Electron up. Clean boot.
- **Agent A (opus)** — end-to-end happy-path: dispatch one real run, watch the lifecycle, verify the S3 orchestrator-notify lands.
- **Agent B (opus)** — conduit health: host reachability, server↔host connection, S4 keepalive, scan for stranded/false-killed runs.

---

## S1–S4 verification (Agent B) — all PASS

| Fix | Check | Result |
|-----|-------|--------|
| S1 boot guard | Boot reconcile didn't false-kill or strand runs | **PASS** — boot took the normal reconcile path; only non-terminal rows were live runs; the single `host-lost` row is ~5h stale from a prior session, not this boot |
| S2 lastSeq reset | (host didn't respawn since boot, so not exercised live) | n/a this run; unit-covered |
| S4 keepalive + stream restart | Watched host `/events?after=0` for 35s | **PASS** — stream stayed open the full 35s, continuous real events + 2 bare-newline keepalives observed |
| conduit health | host `/health`, server `/api/agent-host/health` | **PASS** — host live on 64015, server `HostConnection` reports `connected` to the same hostId/pid |

Host identity: `{pid:25364, hostId:"a44a6406-2d1b-4620-a7de-94297e95332e", port:64015, protocolVersion:1}`.

---

## The showstopper (Agent A) — runs never complete

Dispatched `extractor` pod, input: *"Reply with exactly the word DONE and nothing else, then finish your turn. Do not use any tools."*

Observed:
- PTY transcript shows the agent replied `DONE` and "Worked for 1s". The `claude.exe` process **exited** (`pid:null`).
- The run row stayed `running` for the full 4.5-min cap. Never reached terminal.
- Host's own `list-runs`: the run (and two unrelated real runs) are all **`failed` / `idle-timeout`**, `terminalAt` = `readyAt + 300000ms` exactly.
- No `agent-completed` mailbox envelope (because the terminal transition never fired).

Two of the failed runs (`caisson`, `researcher` pods, dispatcher `01KT463NBV...`) were from a **real orchestrator session**, not the test — so this is hitting live work, not just the probe.

---

## Root cause — host/server `CLAUDE_CONFIG_DIR` split

Completion is decided by the host **tailing claude's on-disk JSONL transcript** and seeing a turn-end event. The host computes that file's path; the agent writes the file. They look in different folders:

```
Host tails:    ~/.claude-work/projects/<encoded-cwd>/<sessionId>.jsonl   ← never created
Agent writes:  ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl        ← actual transcript
```

Confirmed empirically: the dispatched agents' transcripts (`6b3e8a6d…` extractor, `7f367b09…` researcher) are in `~/.claude/...`; my own Claude Code session transcripts are in `~/.claude-work/...`.

### Why they diverge

1. The path is built by `jsonlPathFor()` (`packages/runtime/src/path-resolver.ts`) = `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude` + `/projects/<encoded-cwd>/<sessionId>.jsonl`.
2. The **server** normalizes the var at boot — `applyClaudeRuntimeSettings(readSettings())` (`apps/server/src/index.ts:145`) → `applyClaudeConfigDirOverride` (`apps/server/src/features/settings-onboarding/routes.ts:52-56`) **deletes** the shell-inherited `CLAUDE_CONFIG_DIR` when no settings override is stored. So agents the server spawns (`buildAgentEnv`, `agent-run-factory.ts:827` spreads the cleaned `process.env`) write to the default `~/.claude`.
3. The **out-of-process host** is a separate process (started by dev-supervisor) that **never runs that normalization** → it keeps the shell's `CLAUDE_CONFIG_DIR` (`.claude-work`) and tails there.
4. The start-run request (`AgentHostStartRunRequest`, `packages/runtime/src/agent-host-protocol.ts:43`) sends `env` and `transcriptPath` but **not** `jsonlPath` — so the host recomputes the path with its own divergent env.

Net: host watches an empty path → never sees turn-end → 300s idle timer fires → `failed`.

### Why it bites dogfooding every time

Claude Code sessions set `CLAUDE_CONFIG_DIR` (this machine: `C:\Users\emers\.claude-work`). `restart-stack` launches `pnpm dev:app` from that shell, so the host inherits it. **Any** launch from a shell with `CLAUDE_CONFIG_DIR` set reproduces this. The server cleans its own copy; the host doesn't.

> ⚠️ Not caused by the S1–S4 fixes (those are server/conduit-side). This is the JSONL-path/env layer, pre-existing.

---

## Proposed fix

**Real fix (recommended) — server sends the authoritative path.**
The server computes `jsonlPath = jsonlPathFor(worktreeDir, ccSessionId)` with **its** normalized env and sends it in the start-run request; the host threads `request.jsonlPath` → `AgentRun` input → `low-level-spawn`, which already prefers a passed-in path (`this.input.jsonlPath ?? jsonlPathFor(...)`, see the comment at `low-level-spawn.ts:80`). The two sides then physically cannot disagree.

Scope (small, well-bounded):
1. `agent-host-protocol.ts` — add `jsonlPath?: string` to `AgentHostStartRunRequest`.
2. `agent-run-factory.ts` `buildHostStartRunRequest` — set `jsonlPath: jsonlPathFor(args.input.worktreeDir, args.ccSessionId)`.
3. `packages/agent-host/src/agent-host-service.ts` — pass `request.jsonlPath` into the `AgentRun` input.

**Quick dogfood safety net (1 line):** clear `CLAUDE_CONFIG_DIR` in `scripts/restart-stack.ps1` before launch, so host + server + agents all use `~/.claude` regardless of which Claude Code session started the stack.

**Verify:** restart, re-dispatch the trivial run, confirm it reaches `completed` and the `agent-completed` envelope lands in the dispatcher's mailbox.

---

## Artifacts / evidence

- Stuck test run: `01KT464VD6QH5J2YYKJKZA00HR` (extractor, dispatcher `s3-lifecycle-test-2026-06-02`).
- Real-session runs hit by the same bug: `01KT464RVBM633K7CJRT9KQBXZ` (caisson), `01KT464V1GZSB5FRS17EGBPFM8` (researcher), dispatcher `01KT463NBVCWMHFY11FQNF2J5D`.
- Host list-runs: all three `failed`/`idle-timeout`, `terminalAt = readyAt + 300000`.
- Transcript locations: agents in `~/.claude/projects/E--Claude-Code-Projects-Personal-PC-PTY-Chat/`; CC sessions in `~/.claude-work/projects/...`.
- Memory: `reference_agent_idle_timeout_claude_config_dir_split`.

---
---

# Second pass — independent code+DB forensics (2026-06-02, later same day)

Separate investigation, reached the **same root cause from a different direction** (traced the completion code end-to-end, then mined both run DBs). Corroborates everything above and adds: the **workflow-subagent path has the identical flaw**, the **DB-wide failure distribution**, the **compounding reliability holes**, and a **first-principles framing** of why this whole class exists.

## Corroboration — the timing fingerprint in the DB

Snapshotted both run DBs (`data/pc.sqlite` dev, `C:\Users\emers\Caisson-Dogfood-Data\pc.sqlite` dogfood) read-only and grouped `agent_runs` by failure cause.

Dogfood `agent_runs`: 106 completed · 38 failed · 2 cancelled. The failed rows are dominated by exactly the two shapes this bug predicts:

| cause | timing (ready→death) | meaning |
|---|---|---|
| `idle-timeout` | **exactly 300 / 305 / 330s** | idle timer is armed at `running` and reset on every JSONL event (`agent-run.ts:516`, `resetIdleTimer`). Death at *exactly* `idleMs` ⇒ **zero JSONL events ever reached the run** — while those same agents committed code + called tools. Proves the host/server were watching a dead file the entire run. The "agent produced no output for the idle window" label is on a run that **succeeded**. |
| `server-restart` / `host-lost` | **1,883s · 2,064s · 6,056s · 6,300s · 14,503s** | runs that did their work but were never observed as done, so they sat `running` for up to ~4h until a stack restart fail-closed them. User restarts constantly ⇒ long agents almost never survive to terminal. |

`last_activity_at` is null on the idle-timeout rows — consistent with the resetIdleTimer path never firing.

Confirmed the transcript split empirically too: a *completed* `code-writer` run (`cc_session_id 9e6079ab…`) has its CC JSONL at `~/.claude/projects/E--Claude-Code-Projects-Personal-PC-PTY-Chat/9e6079ab….jsonl` (the **default** dir, where the server's cleaned env points), i.e. it only completed because that run's path happened to line up. The idle-timeout sessions have no JSONL at the polled path at all.

## New — the workflow-subagent path is the SAME single-signal design

The doc above is about dispatched agents (`AgentRun` / agent-host). The **v2 workflow DAG** dispatches through a *different* spawner with the *same* fragility:

- `packages/runtime/src/subagent-spawner.ts:324` — a workflow node's agent resolves to `success` **only** on a `jsonl-turn-end` event from tailing the same on-disk JSONL (`succeedFromTurnEnd`). No positive done-signal.
- `subagent-spawner.ts:334` — `spawn.on('raw', () => resetIdleTimer())` resets the 5-min idle timer on **every raw byte**. claude.exe's interactive TUI repaints its footer/spinner continuously (visible in `transcript.log`: `Finagling… (44s)`, title escapes). So for a workflow subagent the idle backstop is *defeated* — a stuck-but-painting agent rides to the **2h wall-clock** instead of failing at 5 min.
- Same `jsonlPathFor(worktreeDir, ccProviderSessionId)` path math (`low-level-spawn.ts` ← `path-resolver.ts`), so the same `CLAUDE_CONFIG_DIR` / cwd-encoding divergence blinds it.

Net: **both** execution paths infer completion by guessing a JSONL file path. The dispatched path false-fails at 300s; the workflow path can hang for 2h. One root design, two symptoms.

DB confirms the workflow side is thin but real: dogfood `workflow_runs_v2` = 34 completed · 11 failed · 3 cancelled · **1 still `running`**. Dev `workflow_runs_v2` failures are a *different*, fast-fail bug worth noting separately: `expected_output.kind must be one of: answer, prose, payload, repo, external, binary` — a contract-validation throw in `createAgentWorkItem` fails the node instantly and skips downstream (not a stall, but it means those test workflows never exercised the agent path at all).

## New — compounding reliability holes (independent of the path bug)

Even after the `jsonlPath` fix lands, these remain and will bite the 8-step AHEAD flow:

1. **`RetryPolicy` is schema-only.** Zero executor support (`dag-executor.ts` / `step.ts` have no retry/max_attempts/attempt logic). `runLayer` dispatches each node exactly once. One transient blip on a Jira create / GitHub PR / AWS deploy-poll / Playwright run fails the node → fails the **whole** multi-minute run, with no retry.
2. **Persistence is per-LAYER, not per-node-settle.** `dag-executor.ts:169` persists once after the whole `Promise.all` batch. Nodes are marked `running` **in memory only** (`:198`) and never persisted mid-flight — so a crash mid-agent loses even the knowledge the node was dispatched.
3. **Resume is a zombie-maker.** `selectReady` only dispatches `state === 'pending'` nodes. A node persisted `running` is skipped forever on resume, `computeRunStatus` keeps returning `running` → the run never advances, never completes, never fails. This is *why* boot-reconcile fail-closes today — it's the only non-zombie option without new state-machine code.
4. **No idempotency markers.** To resume you'd have to reset `running`→`pending` and re-spawn — and every AHEAD agent is non-idempotent (re-creates the Jira ticket, re-opens the PR, re-fires the deploy). There is no `side_effect` field anywhere in the workflow domain to gate this.
5. **The run lives in a dangling promise.** `fireDagWorkflow` returns `exec.advance()` only `.catch()`-ed for logging by the HTTP caller. If `persist()`/`resolveRef()` throws (DB lock, etc.), the run is left `running` with **no driver** — an unrecoverable zombie until the next boot fail-close.

## First-principles framing (why this class exists, and the fix)

**The violated principle: an agent's completion should be a fact the server is _told_, not a fact it _guesses_ from a file path.**

`claude.exe` interactive never exits on "done" — it returns to a `❯` prompt. The system compensates by inferring "done" from a turn-end line in a transcript whose path it computes independently of the process that writes it. Two independently-derived paths that must stay byte-identical across processes, envs, OS-encoding rules, and CC versions — and when they drift, the system goes silently blind. The idle timer and the restart fail-close are the only backstops, and both **destroy successful work**.

Fix direction (in priority order):

1. **Authoritative path now (the doc's recommended fix).** Server computes `jsonlPath` with its normalized env and sends it in the start-run request; host threads it through. Removes the *divergence*. This is the right immediate move and kills the 300s false-deaths.
2. **But also remove the _guessing_, longer-term.** The agent's mandatory final action is already an MCP call (`pc_submit_deliverable` / `pc_complete_node`). The server **owns that endpoint** — treat its *receipt* as the completion event. That channel cannot path-diverge, cannot be defeated by TUI repaints, and needs no transcript tail. The JSONL tail becomes a *render* source, not the *control* signal. (This is the outbound mirror of the already-decided inbound "ready-ping" — see `project_agent_ready_ping_direction`.)
3. **Demote idle-timeout to failure-only.** With a positive done-signal, 5-min silence means *actually stuck*, never "finished and we missed it."
4. **Make runs durable:** persist per node-settle, reattach/resume instead of fail-close, then add the missing retry wrapper.

Once the observation layer is trustworthy, the 8-step AHEAD flow (PRD → jira-story → zephyr-create → code-writer → pr-opener·dev → ahead-qa → loop → pr-opener·master) maps onto the **existing** engine — it's "build the five agents + wire one DAG," not "rebuild the engine."

## Files read this pass (anchors)

`dag-run-service.ts` · `dag-executor.ts` · `subagent-spawner.ts:220-401` · `workflow-subagent-handshake.ts` · `low-level-spawn.ts` · `jsonl-tailer.ts:464-515` (turn-end rule) · `path-resolver.ts` · `agent-run.ts:512-543,614-655` (idle + completion) · `pod-spawn.ts` · `claude-runtime-bundle.ts:153-187` (env) · `project-runtime.ts:450-505` (documents the same `CLAUDE_CONFIG_DIR` divergence as a prior latent bug).

Memory written: `project_agent_stall_root_cause`.
