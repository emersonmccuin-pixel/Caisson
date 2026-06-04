-- M6 / FD-10 (2026-06-04) — ☠ stage-entry/schedule/event triggers.
--
-- Workflows no longer declare triggers and runs no longer record one. Exactly
-- two ways a run starts: the UI "Run now" button and the orchestrator's
-- pc_fire_workflow tool — both land on the one fire route. The four columns:
--   trigger                  — kind was 'manual' on every live row that matters;
--                              conveys zero information once one kind exists.
--   stage_id                 — only ever set by the deleted stage-on-entry path.
--   triggered_by_session_id  — written as NULL by every caller since 19.3.
--   trigger_context          — written as '{}' by every caller since 19.3.
--
-- DESTRUCTIVE for historical rows' trigger provenance (which run was fired by
-- a stage move). The diary's workflow_started line keeps historical trigger
-- kinds in its data payload for runs that recorded one.

ALTER TABLE workflow_runs_v2 DROP COLUMN trigger;--> statement-breakpoint
ALTER TABLE workflow_runs_v2 DROP COLUMN stage_id;--> statement-breakpoint
ALTER TABLE workflow_runs_v2 DROP COLUMN triggered_by_session_id;--> statement-breakpoint
ALTER TABLE workflow_runs_v2 DROP COLUMN trigger_context;
