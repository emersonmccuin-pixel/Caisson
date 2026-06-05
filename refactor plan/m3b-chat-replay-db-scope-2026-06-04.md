# M3b — chat replay file → DB (2026-06-04)

The last Track M small. M3a's breadcrumb: "`session-replay.ts` reads `jsonl-events.jsonl`;
target = events in SQLite, replay = a query." FD-13 spirit (happenings = append-only logs in
the store) applied to the conversations subsystem; north star: the DB is the source of truth.

---

## Trace — the chat-replay system today

**The data:** every orchestrator chat event (user rows, assistant text, tool calls, turn-ends)
is normalized into envelope rows `{id, sessionId, seq, type:'jsonl', kind, event, source}` and
appended to a per-session file `<dataDir>/projects/<pid>/sessions/<sid>/jsonl-events.jsonl`.
Pre-Section-23 sessions have a legacy `events.jsonl` instead (type:'event').

**ONE writer:** `OrchestratorHostSession.persistJsonlEvent`
(`orchestrator-host-session.ts:636`) — appendFileSync per event; `scanReplayFile` (:742) at
construct resumes `nextSeq` + the source-cursor dedup floor (G7 — host-buffer replays after an
API restart can't double-write history). Insert failure emits `jsonl-persist-error`.

**ONE read chokepoint:** `conversation-replay.ts serviceFor` → `ConversationReplayService` →
`FileTranscriptRepository` → `loadSessionReplayCheckpoint` (`session-replay.ts` — the file
parser w/ legacy fallback). Every replay surface flows through it:
- `GET /sessions/:id/events` (Sessions tab, `?afterSeq=` cursor reads)
- WS connect snapshot + `switch-session` broadcast + new/resume routes (`session-replay` envelope)
- `orchestrator-runtime-snapshot.payload` — diagnostics only (replayPath/exists/lineCount/
  highWaterSeq).

**Not this subsystem:** agent-run transcripts (CC's own JSONL via `AgentRunJsonlTailer`) ·
the raw terminal transcript tail (`transcript.log`) · live WS fanout (events stream live over
the WS jsonl-event channel; the replay log exists ONLY for reconnect/history).

**Sessions are never deleted by code** — no delete path to cascade.

## Refute pass

- "The repository seam means there are two paths" — NO. `FileTranscriptRepository` is the ONLY
  implementation and it delegates to the one file parser. The slice-006 seam was built FOR this
  cutover. M3b swaps the implementation behind the seam and deletes the file one.
- "Keep the file as a fallback" — REFUTED (one path). The file parser survives ONLY inside the
  one-time backfill importer; the live read path is the DB query, no fallback.
- "Need live-outbox facts per chat event" — REFUTED. Live delivery already rides the WS
  jsonl-event channel; the replay store is a history read-model. Adding outbox rows would be a
  second fanout for traffic that already fans out (and chat events are high-volume).
- "Backfill lazily on first read" — REFUTED. Lazy import inside a read path makes reads
  write (and the WS connect path is hot). One boot sweep, idempotent, rename-after-import.

## Decisions

- **D1 — `conversation_events` table** (migration 0047): `id` pk (`<sid>:<seq>`) · `session_id`
  · `seq` · `type` ('jsonl'|'event') · `kind` · `event` (JSON) · `source_kind` · `source_cursor`
  · `created_at`; UNIQUE (session_id, seq). Plain repo door (`appendConversationEvent` +
  reads); NO outbox row (see refute).
- **D2 — writer swap:** `persistJsonlEvent` inserts the row; `scanReplayFile` →
  `getConversationReplayState(sessionId)` (MAX(seq)+1, MAX(source_cursor)). The
  `replayEventsPath` input dies. `jsonl-persist-error` semantics kept on insert throw.
- **D3 — read swap:** `DbTranscriptRepository` implements the existing `TranscriptRepository`
  seam (checkpoint = ordered query; listAfter = `seq > ?` w/ stable full high-water).
  ☠ `FileTranscriptRepository` · ☠ `session-replay.ts` (parser moves whole into the backfill
  importer, marked import-only). Response shapes stay byte-identical.
- **D4 — boot backfill, rename-after-import:** one boot sweep walks
  `<dataDir>/projects/*/sessions/*/`; a dir with `jsonl-events.jsonl` (or legacy `events.jsonl`)
  and ZERO `conversation_events` rows for that session imports via the old parser in one txn,
  then renames the file `→ *.imported` (forensics kept; sweep self-extinguishes). A session
  with rows already → rename only (crash-between-import-and-rename is idempotent).
- **D5 — snapshot diagnostics re-point:** `replayExists` = has rows · `replayLineCount` = row
  count · `replayHighWaterSeq` = MAX(seq) · `replayPath` = null (the field survives the wire
  contract; the store is no longer a path).

## Slices

- **A** — schema 0047 + `conversation-events.ts` repo + tests.
- **B** — writer swap in `OrchestratorHostSession` + test rewrite (file asserts → row asserts).
- **C** — `DbTranscriptRepository` + read swap + ☠ file reader/repo + boot backfill importer +
  snapshot diagnostics + tests.
- **D** — live: restart stack → backfill imports existing chats (files renamed) → history
  renders in the chat + Sessions tab → live chat streams → reconnect replays from DB. Docs
  sweep + memory.

## OUTCOME — ✅ ALL FOUR SLICES SHIPPED + LIVE GREEN (2026-06-04)

Commits: scope `689b304d` · A `e9199ddb` · B `928f9bb6` · C `cf9148cc` · D (this sweep).
Suites: server 290 · app-services 83 · db 47 · workspace typecheck — green.

**Live verify (dev stack):**
- Boot backfill: **21,271 events from 313 sessions imported; 664 files renamed `*.imported`;
  zero `jsonl-events.jsonl` remain.** Second boot sweeps nothing (self-extinguished).
- Historical replay from the DB: the biggest session (1,654 events) serves
  `?afterSeq=1650` → 4 rows, correct kinds + source cursors, stable high water.
- Live round-trip: fresh orchestrator session → injected turn ("reply kumquat") → reply
  persisted as `conversation_events` rows → replay route returns them (highWaterSeq 9,
  "kumquat" present).

## Known risks

- The backfill must use the SAME parser semantics (skip malformed lines, max(count,maxSeq)+1
  seq rules) or historical seq numbering shifts under the UI's feet — move the parser, don't
  rewrite it.
- `orchestrator-host-session.test.ts` asserts file lines today — rewrite asserts to rows
  (same scenarios, incl. the dedup-cursor-floor live-fire regression).
- Event payloads can be large (full assistant turns); SQLite handles it (attachments already
  live in the DB by decision).
