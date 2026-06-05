-- M3b (FD-13 spirit, conversations subsystem) — chat replay moves into the DB.
--
-- Replaces the per-session `jsonl-events.jsonl` append file as the orchestrator
-- chat's replay store: the OrchestratorHostSession writes one row per
-- normalized chat event; replay (Sessions tab, WS connect snapshot, afterSeq
-- cursor reads) becomes a query. The on-disk files are imported once at boot
-- (renamed `*.imported` after) and the file reader dies.
--
-- `seq` is the per-session replay cursor (NOT the global live-outbox cursor).
-- `source_cursor` is the provider-row cursor that drives the G7 dedup floor
-- (host-buffer replays after an API restart must not double-write history).

CREATE TABLE conversation_events (
	id text PRIMARY KEY NOT NULL,
	session_id text NOT NULL,
	seq integer NOT NULL,
	type text NOT NULL,
	kind text,
	event text NOT NULL,
	source_kind text NOT NULL,
	source_cursor integer,
	created_at integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX conversation_events_session_seq_idx ON conversation_events (session_id, seq);
