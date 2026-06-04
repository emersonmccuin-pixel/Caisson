-- M6 slice D (2026-06-04) — ☠ agent_contracts.attempt + issued_by.
--
-- Dead fields (M5 finding): written as 0 / NULL by every caller since the
-- table was born; read by one route + one UI badge that never rendered
-- (attempt > 1 was never true). Retries are the workflow LOOP step's business
-- (rejectIterations on the run); provenance is the diary's (agent_dispatched
-- carries the cross-link).

ALTER TABLE agent_contracts DROP COLUMN attempt;--> statement-breakpoint
ALTER TABLE agent_contracts DROP COLUMN issued_by;
