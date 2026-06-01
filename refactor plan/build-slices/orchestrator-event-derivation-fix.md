# Orchestrator event-derivation fix — foundational

Branch `refactor/auto-pathway`. Build-ready design. No band-aid: kill O(N)-per-frame at the source.

## 1. Root cause + first principle

- Freeze: Electron dev app goes click-dead (F5 recovers) when the orchestrator streams — esp. tool calls — in a session WITH history. Fresh/empty session never freezes.
- Confirmed live (owner-stack named `Orchestrator.tsx` twice; render-diff probe): per streamed frame `events.len` grows by 1 (812→900+), and the ONLY changing values are `events` + `sessionUsage`.
- NOT a WS flood (rate probe never tripped >60/s).
- Mechanism:
  - `events = useMemo(() => materializeChatSessionEvents(sessionState), [project, sessionState])` (`use-project-ws.ts:97`) — every envelope dispatch produces a NEW `sessionState`, so `events` gets a **new array identity per frame**.
  - `sessionUsage = useMemo(fold over ALL events, [events])` (`Orchestrator.tsx:334`) — **re-folds the entire 800–900+ array every frame** AND returns a **new object** each time (fresh `{}` literal, never reference-equal).
  - That fresh object fires the telemetry effect `setTelemetry({ model, usage: sessionUsage })` (`Orchestrator.tsx:373`) **every frame**, writing the zustand store every frame → App header re-render + store-notify cascade every frame.
  - Cost ≈ (array size × frames-per-burst). Tool-call bursts are the densest frame source; large history makes the per-frame fold expensive → main thread saturates → clicks dead.
- **First principle the fix MUST satisfy:** a component must never do work proportional to the entire stream history on every incremental append. Stream aggregates are maintained **incrementally (O(1) amortized per appended event) at the single point of append**, and exposed as **referentially-stable** values. A high-frequency token frame must trigger neither an O(N) re-fold nor a spurious effect/render cascade.

## 2. Verified map of every event-derived value/effect in `Orchestrator.tsx`

Legend: FULL = folds entire array; EARLY = walks newest-first with `break`/`return`; RESULT-ID = identity of the returned value across frames; PER-FRAME EFFECT = does its downstream `useEffect` fire on every `events` change.

| # | Value / effect | Line | Scan | Returned-value identity | Drives effect | Per-frame fire? |
|---|---|---|---|---|---|---|
| a | `setSession` scan (`session-changed` / `session-title`) | effect 300–316 | EARLY (newest-first) | n/a (setState) | inline | **YES** (effect body runs every `events` change; `setSession` is a no-op bail when value unchanged, but the SCAN runs every frame) |
| b | `setRuntimeSnapshot` scan (`runtime-state`) | effect 317–325 | EARLY | n/a | inline | **YES** (scan runs every frame) |
| c | `sessionUsage` | memo 334–351 | **FULL** | **NEW object every frame** | telemetry effect (e) | n/a |
| d | `liveModel` | memo 353–361 | EARLY | stable string\|null | telemetry effect (e) | n/a |
| e | `setTelemetry({ model: liveModel, usage: sessionUsage })` | effect 373–375 | — | — | store write | **YES** — deps include `sessionUsage` whose identity changes every frame → **the offending cascade** |
| f | `setSessionMeta` | effect 376–381 | — | — | store write | NO (deps = `session?.id`, `session?.title` — stable) |
| g | `latestSessionState` | memo 393–401 | EARLY | stable string\|null | runtime effect (j) | n/a |
| h | `latestRuntimeState` | memo 403–412 | EARLY | stable string\|null | (read inline) | n/a |
| i | `lastTurnDurationMs` | memo 417–427 | EARLY | stable number\|null | runtime effect (j) | n/a |
| j | `setRuntime({ sessionState, lastTurnDurationMs })` | effect 429–431 | — | — | store write | NO (deps = primitive values; fire only on change) |
| k | `terminalInputFailure` | memo 599–602 | EARLY | stable object\|null (early-break) | — | n/a |
| l | `clearTelemetry` on unmount | effect 382 | — | — | — | no |

Findings:
- **The single freeze driver is (c)→(e):** FULL fold + new-object-per-frame → telemetry effect every frame → store cascade every frame, work ∝ array size.
- (a) and (b) re-scan the FULL array's tail every frame, but EARLY-break at the first match near the end → cheap in practice, and their `setState` is a value no-op when unchanged. They still run a scan + effect every frame; worth eliminating for cleanliness, secondary to (c)/(e).
- (d)(g)(h)(i)(k) are EARLY-break memos returning stable primitives; their downstream effects (f)(j) already fire only on value change. They re-scan per frame (cheap, bounded near the tail) but do NOT cascade.
- After the fix, `Orchestrator` still re-renders per frame because `ChatSurface` consumes `events` for the timeline — that is correct and unavoidable (the chat must show new tokens). The fix makes that per-frame re-render **cheap**: no FULL fold, no store write, no effect fan-out.

## 3. Chosen approach + why

**(A) Incremental aggregates at the append site (the reducer).** REJECT (B) cursor memo in the component.

Extend `ChatSessionReducerState` with a derived `aggregates` block — running token totals + latest model + latest session-state + latest turn-duration — recomputed **deterministically as a pure function of the action's events at each dispatch**, carried on the returned state with a **stable identity when unchanged**. `Orchestrator` reads `sessionState.aggregates` (via the hook) instead of folding `events`.

First-principles justification (one paragraph): The aggregates are a projection of the same event stream the reducer already owns and appends to; deriving them anywhere else (a component memo) re-reads the materialized array and duplicates the source of truth, which is exactly the O(N)-per-frame fold we are eliminating. Maintaining them at the one append site makes the cost O(1) amortized per event, gives a single authority that already handles every correctness-critical path (snapshot replay, session-new reset, transition, trim, dedupe), and lets us hand consumers a referentially-stable value so the high-frequency token frame triggers neither a re-fold nor a store cascade. Crucially the reducer is pure: we compute the next aggregates from `prev.aggregates` + the new entries **inside the reducer's returned state**, never via a `useEffect` side-effect — so StrictMode's double-invoke and any replay are idempotent (same input state + action ⇒ same output), which a mutate-across-dispatches accumulator would corrupt.

Rejected — **(B) cursor-based incremental memo in `Orchestrator`:** a `useRef` accumulator keyed on processed index, folding `events.slice(lastIndex)` per render. It would fix the perf symptom and matches the prior "index cursor" precedent, but: (1) it leaves derivation in the component, re-introducing a second source of truth that must independently get reset/replay/session-transition right (the reducer already encodes all of these — duplicating that logic is the fragile part); (2) a render-time ref mutation is impure and double-runs under StrictMode unless carefully guarded; (3) it cannot make effects (a)(b) go away. (A) is strictly more foundational and removes the whole class.

## 4. Exact file-by-file changes

### 4.1 `apps/web/src/hooks/chat-session-reducer.ts`

Add the aggregate types + a pure folder, thread it through every state-producing path.

```ts
// New — the incrementally-maintained stream projection.
export interface ChatSessionAggregates {
  usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number };
  latestModel: string | null;          // most-recent jsonl-usage.model (non-null)
  latestSessionState: string | null;   // most-recent jsonl-session-state.state
  lastTurnDurationMs: number | null;    // most-recent jsonl-turn-duration.durationMs (non-null)
}

const EMPTY_AGGREGATES: ChatSessionAggregates = {
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  latestModel: null,
  latestSessionState: null,
  lastTurnDurationMs: null,
};
```

- Extend `ChatSessionReducerState` with: `aggregates: ChatSessionAggregates;`
- `createChatSessionState`: initialize `aggregates: EMPTY_AGGREGATES` (reset path gets it free — `reset-project` and `session-changed:new-session` both rebuild empties).
- Add a pure folder that updates aggregates from a single envelope:

```ts
// Pure: derive next aggregates from prev + one envelope. Returns prev (same
// reference) when the envelope contributes nothing → referential stability.
function foldAggregate(prev: ChatSessionAggregates, env: WsEnvelope): ChatSessionAggregates {
  if (env.type !== 'jsonl') return prev;
  const ev = (env as WsEnvelope & { event: JsonlEvent }).event;
  if (!ev) return prev;
  switch (ev.kind) {
    case 'jsonl-usage':
      return {
        ...prev,
        usage: {
          inputTokens: prev.usage.inputTokens + ev.inputTokens,
          outputTokens: prev.usage.outputTokens + ev.outputTokens,
          cacheCreationTokens: prev.usage.cacheCreationTokens + ev.cacheCreationTokens,
          cacheReadTokens: prev.usage.cacheReadTokens + ev.cacheReadTokens,
        },
        latestModel: ev.model ?? prev.latestModel,
      };
    case 'jsonl-session-state':
      return prev.latestSessionState === ev.state ? prev : { ...prev, latestSessionState: ev.state };
    case 'jsonl-turn-duration':
      return ev.durationMs == null ? prev : { ...prev, lastTurnDurationMs: ev.durationMs };
    default:
      return prev;
  }
}

// Pure: full recompute from a materialized event list (used by snapshot/replay
// paths, where we rebuild `sequenced`/`timeline` wholesale). Deterministic.
function aggregatesFromEvents(events: WsEnvelope[]): ChatSessionAggregates {
  let agg = EMPTY_AGGREGATES;
  for (const env of events) agg = foldAggregate(agg, env);
  return agg;
}
```

Wire-in per state-producing path (each must set `aggregates`):

- **`applyDelta` (the live append path, 212):** this is the hot path. On the new-entry branch (and the dedupe/replace branch — a re-delivered `jsonl-usage` would double-count if we naively re-fold, see Risks): only fold when the entry is genuinely NEW. The dedupe `existing` branch (231) returns early WITHOUT folding (the envelope was already counted on first arrival). The new branch (242) does `aggregates: foldAggregate(state.aggregates, entry.env)`. Note `applyDelta` handles `jsonl` envelopes via `sequencedEntryFromEnvelope`; usage/session-state/turn-duration carry a `seq`, so they flow here, not through `appendUnsequenced`.
- **`appendUnsequenced` (353):** pass `aggregates` through unchanged (`...state`). Unsequenced envelopes (`send-ack`, `runtime-state`, `session-changed`, queue snapshots) never contribute to aggregates. (Defensive: `foldAggregate` returns `prev` for any non-jsonl type anyway, but unsequenced jsonl is not a real case — keep it a pass-through to avoid double-counting a jsonl that also lands sequenced.)
- **`appendTerminalRaw` (380):** pass through (`type:'raw'` never contributes).
- **`applySnapshot` (170):** REBUILD aggregates wholesale from the replay set — `aggregates: aggregatesFromEvents(replayEvents)` computed from the same `replayEvents` it sorts into `sequenced` (do NOT carry forward the prior aggregates; a snapshot is a full re-seed of the live timeline). Set it on the `next` object before the per-entry timeline loop. Past-session/replay totals stay correct because `jsonl-usage` survives in `events.jsonl` since slice 0e (per the comment at `Orchestrator.tsx:331`).
- **`applySessionChanged` → `new-session` branch (327):** reset to `EMPTY_AGGREGATES` (alongside the existing `highWaterSeq: 0, sequenced: []` reset). The resume branch (343) passes through.
- **`applySessionTransition` (301):** composed of `applySessionChanged` + `applySnapshot` — already correct (new-session zeros, then snapshot re-seeds from replay).
- **`trimTimeline` (551):** **do NOT recompute aggregates on trim.** Trimming drops the oldest 10k+ overflow entries from the rendered timeline, but totals are cumulative over the WHOLE session — recomputing from the trimmed (windowed) set would CORRUPT the totals (the explicit "do not window the aggregates" constraint). `aggregates` is carried forward untouched by trim (it is monotonic session-cumulative, decoupled from timeline retention). Document this with a one-line comment.

### 4.2 `apps/web/src/hooks/use-project-ws.ts`

Expose aggregates next to `events`, keyed to the active project (mirror the `events` guard at 97).

```ts
const aggregates = useMemo(
  () =>
    project && sessionState.projectId === project.id
      ? sessionState.aggregates
      : EMPTY_AGGREGATES,            // import from reducer
  [project, sessionState],
);
```

- Add `aggregates: ChatSessionAggregates` to `UseProjectWsResult` and return it.
- `aggregates` identity is stable across frames whenever no contributing envelope arrived this dispatch (the reducer returns the same `aggregates` reference): a tool-call frame (`jsonl-tool-call`/`jsonl-tool-result`/`jsonl-stream-event`) carries no usage/state/duration, so `foldAggregate` returns `prev` and the reference is preserved — exactly the frames driving the freeze become no-ops for telemetry.

### 4.3 thread through `App.tsx` → `Shell` → `Center` → `Orchestrator`

- `App.tsx`: `useProjectWs` already destructured as `ws`; pass `ws.aggregates` down the same path `ws.events`/`wsSend` already travel (search `wsEvents={ws.events}` at `App.tsx:459` and add a sibling `wsAggregates={ws.aggregates}`). Mirror the existing prop drill through `Shell.tsx` → center → `Orchestrator` (the same chain `events` uses). Add the prop to each component's props type.
- Contract type: export `ChatSessionAggregates` + `EMPTY_AGGREGATES` from the reducer; import where threaded.

### 4.4 `apps/web/src/components/Orchestrator.tsx`

- Add `aggregates: ChatSessionAggregates` to `OrchestratorProps`.
- **DELETE** `sessionUsage` memo (334–351), `liveModel` memo (353–361), `latestSessionState` memo (393–401), `lastTurnDurationMs` memo (417–427).
- Replace reads:
  - `sessionUsage` → `aggregates.usage`.
  - `liveModel` → `aggregates.latestModel ?? session?.model ?? null` (preserve the `session?.model` fallback that line 360 had).
  - `latestSessionState` → `aggregates.latestSessionState`.
  - `lastTurnDurationMs` → `aggregates.lastTurnDurationMs`.
- Telemetry effect (373) becomes:
  ```ts
  const liveModel = aggregates.latestModel ?? session?.model ?? null;
  useEffect(() => {
    setTelemetry({ model: liveModel, usage: aggregates.usage });
  }, [liveModel, aggregates.usage, setTelemetry]);
  ```
  `aggregates.usage` is reference-stable across non-usage frames → effect no longer fires per tool-call frame. (`session?.model` is itself stable; `liveModel` recomputes cheaply inline.)
- Runtime effect (429) deps become `[aggregates.latestSessionState, aggregates.lastTurnDurationMs, setRuntime]` — fires only on actual change (unchanged from current behavior, now without a per-frame memo).
- `composerAvailabilityFor` / `composerPlaceholderForSessionState` read `aggregates.latestSessionState` — same values, no behavior change.
- Effects (a) `setSession` scan (300) and (b) `setRuntimeSnapshot` scan (317): **out of scope for the perf fix** (EARLY-break, cheap), but optionally migrate `runtime-state` / `session-title` / `session-changed` "latest" into aggregates in a follow-up to retire the two per-frame scans entirely. Note as a follow-up; do not expand this slice.
- `latestRuntimeState` (403) and `terminalInputFailure` (599): leave as-is (EARLY-break memos, no cascade).
- Remove the TEMP loop probe block (731–755) and the rate probe in `use-project-ws.ts` (75–76, 243–253) once live-verified — they were diagnostic scaffolding for this bug.

## 5. Referential stability — how it is guaranteed per value

- `aggregates` (the object): `foldAggregate` returns `prev` unchanged for any envelope that contributes nothing; `applyDelta`'s no-fold dedupe branch and the unsequenced/raw pass-throughs keep the same reference. Tool-call/stream frames (the freeze drivers) hit these no-op paths → `sessionState.aggregates` keeps identity → the `useMemo` in `use-project-ws.ts` returns the same reference → `aggregates.usage` is reference-equal → telemetry effect deps unchanged → no fire.
- `aggregates.usage` (the nested object): only re-created on a `jsonl-usage` envelope (rare relative to token/tool frames). When unchanged, same reference. This is the dep that previously thrashed.
- `aggregates.latestModel / latestSessionState / lastTurnDurationMs`: primitives — referentially trivial; effects keyed on them fire only on value change.
- `EMPTY_AGGREGATES`: a module-level frozen-by-convention singleton; the inactive-project guard and reset paths return the SAME reference (no spurious effect on project switch beyond the legitimate clear).

## 6. Per-frame cascade — confirmation it is eliminated

- BEFORE: tool-call frame → new `events` identity → `sessionUsage` re-fold (O(N)) + new object → telemetry effect (e) fires → zustand `set` → header re-render + subscriber notify. Every frame. Work ∝ N.
- AFTER: tool-call frame → new `events` identity (still, for the timeline) → `aggregates` reference UNCHANGED (no usage/state/duration in the frame) → telemetry effect (e) deps unchanged → **does NOT fire** → no store write, no header cascade. `Orchestrator` re-renders (ChatSurface needs the new `events`) but the body is now O(1): no fold, no effect, no store write.
- Effects that STOP firing per frame: **(e) `setTelemetry`** (the offender) — now fires only on a `jsonl-usage` or model change. (j) `setRuntime` already fired only on change; unchanged. (f) `setSessionMeta` already keyed on session; unchanged.
- Effects (a)(b) still run their tail-scan per frame (EARLY-break, ~O(1) near the tail) — acceptable; flagged as optional follow-up to fully retire.
- Net: the only per-frame cost becomes ChatSurface's own timeline render, which is already windowed/virtualized per the prior "unbounded events[]" fix — so the main thread no longer saturates and clicks stay live.

## 7. Tests — `apps/web/test/chat-session-aggregates.test.ts` (node:test + tsx)

Import `chatSessionReducer`, `createChatSessionState`, `materializeChatSessionEvents`, `EMPTY_AGGREGATES`, `aggregatesFromEvents` (export it for the oracle), and the envelope builders.

1. **Incremental == full-fold:** dispatch N `jsonl-usage` envelopes (varied token fields) via `{type:'envelope'}`; assert `state.aggregates.usage` deep-equals `aggregatesFromEvents(materializeChatSessionEvents(state))` (the brute-force oracle). Same for a mixed stream (usage + session-state + turn-duration + tool-call + raw).
2. **Latest-wins:** after several `jsonl-session-state` and `jsonl-turn-duration` envelopes, `latestSessionState`/`lastTurnDurationMs` equal the last non-null seen; a `jsonl-usage` with `model:null` does NOT clear `latestModel`.
3. **Reset clears:** `reset-project` and a `session-changed:new-session` both yield `aggregates` deep-equal to `EMPTY_AGGREGATES` (and resume does NOT reset).
4. **Stable identity when unchanged:** dispatch a `jsonl-tool-call` (sequenced) envelope → `next.aggregates === prev.aggregates` (reference). Dispatch a `raw`/`send-ack` → same reference.
5. **No double-count on re-delivery / idempotent:** dispatch the SAME `jsonl-usage` envelope twice (same `sessionId:seq` key → dedupe branch); totals count it ONCE. Replaying the reducer over the same action list from the same start state yields identical aggregates (StrictMode-double-invoke safety).
6. **Snapshot re-seed:** apply a `session-replay` with K usage rows; `aggregates.usage` equals the sum over those K, independent of any prior live state.
7. **Trim does not corrupt totals:** push >`MAX_TIMELINE_ENTRIES` entries including usage rows that get trimmed; assert `aggregates.usage` still reflects ALL usage rows (cumulative), not just the retained window.

## 8. Gates

- `pnpm --filter @pc/web typecheck` (or repo-root `pnpm typecheck`) — clean.
- `pnpm --filter @pc/web test` — new aggregates suite + existing web suites (`project-live-events`, `agent-run-*`, `workflow-*`, `mailbox-live-events`, `areas-filter`) green.
- `pnpm lint` if the repo gate runs it (the removed probes also clear two `eslint-disable no-console`).

## 9. Live-verify plan

- `scripts/restart-stack.ps1` (restart-stack skill) for a clean boot.
- Open a project with a LARGE accumulated session (the repro condition; fresh sessions never froze).
- Trigger a tool-call burst (ask the orchestrator to read/grep several files) — the dense-frame condition.
- Watch: the `[loopprobe orc-render]` render-diff probe should NO LONGER list `sessionUsage` as a per-frame change, and the changed-set should drop to `events` only (or go quiet at the 30–34 sample window); the WS rate probe stays silent (was never the cause).
- Confirm: clicks stay live during the burst; no F5 needed; token roll-up in header + StatusBar still updates when a `jsonl-usage` actually lands; composer placeholder still reacts to `session-state`.
- Then strip the TEMP probes (Orchestrator 731–755; use-project-ws 75–76, 243–253) and re-verify clean.

## 10. Risks

- **Reducer is core** — every state-producing path must set `aggregates` or TS will error (it is required on the interface) — that is the safety net; lean on it.
- **Double-count on re-delivery:** `applyDelta`'s dedupe `existing` branch MUST NOT fold (the envelope was counted on first arrival). Only the genuinely-new branch folds. Test 5 guards this.
- **Snapshot vs live boundary:** `applySnapshot` re-seeds aggregates from the replay set (full recompute), NOT carry-forward — a live `jsonl-usage` that arrived before the snapshot would otherwise be double-counted when the snapshot also contains it. Re-seed is the correct, deterministic choice. (Resume/transition compose snapshot, so they inherit this.)
- **StrictMode / replay idempotency:** aggregates are a PURE function of `(prevState, action)` computed in the reducer's returned value — never accumulated via a `useEffect` or a render-time ref mutation. Re-invoking the reducer with the same inputs yields the same output. Do NOT introduce any mutate-across-dispatches accumulator (the reason (B) was rejected). Test 5 (replay) + Test 1 (oracle equality) lock this.
- **Trim corruption:** explicitly do not recompute aggregates from the trimmed window — they are session-cumulative and decoupled from timeline retention (Test 7).
- **Past-session view:** `Orchestrator` uses `sourceEvents = viewingSessionId ? pastEvents : events` for the chat render, but telemetry/aggregates read the LIVE `sessionState.aggregates` — confirm the header token roll-up while viewing a past session is acceptable (current `sessionUsage` already folded the live `events`, not `pastEvents`, so this is **no behavior change**). If the product wants past-session totals in the header, that is a separate enhancement (would need pastEvents aggregates) — out of scope; note it.
