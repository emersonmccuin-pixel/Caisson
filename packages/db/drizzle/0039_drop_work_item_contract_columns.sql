-- Slice 023 — contract-first switchover, schema cleanup (LAST slice).
--
-- The agent contract is now the authority for dispatch + verification
-- (slices 014b/019/020/021/022). The legacy "work-item-IS-the-contract"
-- columns added in 0016 are dead — nothing in the codebase reads them.
-- Drop all nine + the agent-task filter index.
--
-- DESTRUCTIVE: this discards any data still in these columns. Reversible only
-- by restore (back up the DB before this applies on the next boot). The live
-- contract data lives in `agent_contracts` (migration 0038), untouched here.
--
-- KEPT on work_items (NOT contract baggage): is_workflow_root, area_id,
-- callsign, position, version, history.

DROP INDEX IF EXISTS `work_items_agent_task_idx`;--> statement-breakpoint

ALTER TABLE work_items DROP COLUMN is_agent_task;--> statement-breakpoint
ALTER TABLE work_items DROP COLUMN ephemeral;--> statement-breakpoint
ALTER TABLE work_items DROP COLUMN acceptance_criteria;--> statement-breakpoint
ALTER TABLE work_items DROP COLUMN expected_output;--> statement-breakpoint
ALTER TABLE work_items DROP COLUMN verification_tier;--> statement-breakpoint
ALTER TABLE work_items DROP COLUMN verification_status;--> statement-breakpoint
ALTER TABLE work_items DROP COLUMN verification_notes;--> statement-breakpoint
ALTER TABLE work_items DROP COLUMN assigned_agent_run_id;--> statement-breakpoint
ALTER TABLE work_items DROP COLUMN worktree_path;
