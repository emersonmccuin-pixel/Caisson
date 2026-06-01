# 018 Client Live-Event Store — the single UI-update door (client half of slice 015)

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-06-01 |
| Branch | `refactor/auto-pathway` |
| Status | Spike PROVEN + committed; full slice planned (build in a fresh session) |
| Priority | NEW TOP PRIORITY — blocks 017 Phase C; build before 013/014 |
| Subject | Replace the fragmented, positional-cursor live-event consumption with ONE identity-keyed client store that every view subscribes to. |

### The core finding (root cause of "nothing feels live", proven 2026-06-01)

The **server spine is correct** (proven exhaustively): durable `live_outbox` → relay → WS delivery → replay on reconnect. Slice 015 built that door right.

**The break is on the client and it's architectural:**
1. Relay `live-event` frames are dispatched into `chatSessionReducer` and surface via `materializeChatSessionEvents()` — the SAME array that holds chat messages, jsonl, runtime-state, send-queue snapshots. Live domain events have no dedicated channel.
2. Every view re-scans that shared array with its OWN raw **positional index cursor** — ≥4 independent hand-rolled implementations: `useResourceList` (`lastProcessedIdx`; agent-runs, workflow-runs, work-items Table/Focus), `KanbanBoard` (its own `kanbanLastIdx` + local state), `InitiativeInspector` (explicitly STATIC — no live refresh, admitted in code), plus the attachment consumers + `use-rich-link-invalidator`.
3. **Positional cursors over a re-derived array is the bug.** `materializeChatSessionEvents` REBUILDS the timeline on `session-replay`/snapshot/reset — constant during active agent sessions. After a rebuild an integer index no longer points at the same event, so frames below the cursor are silently skipped. On a calm fresh reload there's no rebuild → it works; during active sessions → it intermittently fails. This exactly matches "flaky since the beginning, looks fine in spot-checks".

Empirically confirmed: a work item created on a fresh-reloaded board appeared live; the same op after a chat-timeline rebuild (forced new-session) did NOT (old path) — while the server delivered the frame and the client cursor advanced both times.

### Decision

Complete the slice-015 ADR on the CLIENT: ONE dedicated live-event store, identity-keyed (`(entity, entityId)` + `version` dedup), fed DIRECTLY from the WS handler — never from the chat timeline. Every resource view subscribes by entity. This is rebuild-proof by construction (identity, not position).

## 2. Spike status (DONE — commit on branch, message "Slice 018 spike")

- `apps/web/src/store/live-store.ts` — Zustand store: `byKey: Map<\`${entity}::${entityId}\`, LiveEvent>` with version dedup + `applyEnvelope`; `useLiveWorkItems(projectId)` selector.
- `apps/web/src/hooks/use-project-ws.ts` — feeds `useLiveStore.getState().applyEnvelope(env)` for every `live-event` frame (BESIDE the existing chat-reducer dispatch — reconcile-first).
- `apps/web/src/components/KanbanBoard.tsx` — positional `kanbanLastIdx` scan REPLACED by a `useLiveWorkItems`-driven merge (by id + version; drop on `deletedAt`).
- **Live-verified**: item created after a forced new-session chat-timeline rebuild still appears live on the Kanban (the case that failed before). Web typecheck + 33 tests green.

## 3. Scope (the full slice)

1. **Generalize the store + selector.** Per-entity selectors (or one `useLiveRecords(entity, projectId, { extract, getId, getVersion, isTerminal })`) covering: `work-item`, `agent-run`, `workflow-run`, `attachment`, `area`, `pod`, `workflow-definition`, `workflow-review`, `mailbox-message`, `pending-interaction`, `project`, `session-title`, etc. Handle `version: null` entities (last-write-wins) explicitly.
2. **Seed model.** HTTP list = seed; live frames = apply-on-top by version. Decide one reconcile pattern: either the store holds seeds too (single source) or views merge store onto a fetched list (spike pattern). Prefer the store as the single source where practical.
3. **Migrate every view** off its bespoke scan onto the store: `useResourceList` consumers (agent-run/workflow-run/work-item Table+Focus → ActivityPanel regions), KanbanBoard (done in spike), `InitiativeInspector` (give it live refresh — currently static), attachment consumers, `use-rich-link-invalidator`.
4. **Pull live-events OFF the chat timeline.** Stop routing `live-event` frames through `chatSessionReducer`/`materializeChatSessionEvents`; the timeline returns to chat-only (jsonl/runtime/send-queue/session). Remove the live-event retention added in 015b.
5. **Reconnect / reset.** Wire `live-reset` → clear the store (or affected entity) + trigger reseed (the existing epoch bump). Ensure the per-socket `catchUp` replay flows into the store.
6. **Delete the old paths.** Remove `useResourceList`'s positional scan, the Kanban's old scan (done), the static-inspector workaround, ad-hoc attachment scans. One mechanism, enforced.
7. **Project scoping / memory.** The spike store accumulates across projects (selector filters by projectId). Decide on per-project partitioning / pruning so it doesn't grow unbounded.

## 4. Reconcile-first ordering (safety)

Ship the store BESIDE each old scan, migrate one view at a time, verify each LIVE **during an active agent session** (not just a calm reload — that's the failure condition), then delete that view's old scan. Do not pull live-events off the chat timeline (step 4) until all consumers are migrated.

## 5. Verification (the bar)

Every migrated view must pass the **active-session** test: with the orchestrator spawned and a chat-timeline rebuild having occurred (new session / reconnect / mid-turn), a mutation (create/patch/delete/state-change) propagates live with NO reload. Two tabs for cross-tab. Plus: reconnect replay, below-floor `live-reset` reseed, version-dedup (no double-render / no stale overwrite).

## 6. Relationship to 017

017 Phase A (server fixes: delivery flip + durable announce + attachment outbox + workflow boot-reconcile) is DONE and correct. **017 Phase C (delete Channel + old paths) stays BLOCKED until 018 lands** — deleting the fallback while the live UI is unreliable would make the app worse. After 018: resume 017 Phase C, then 013/014.

## 7. Stop conditions

- If pulling live-events off the chat timeline (step 4) breaks any chat rendering, STOP — the timeline still needs its non-live frames.
- Adding a new server emit / contract is out of scope — the server spine is correct and frozen here.
