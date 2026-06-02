-- Slice 013 — first-class agent contracts.
--
-- Additive only: a new `agent_contracts` table + a nullable `agent_runs.contract_id`
-- FK. The legacy `work_items` contract columns are KEPT (read-through shim this
-- slice; removed in 014/cleanup). No reader breaks mid-migration.
--
-- Backfill: one `agent_contracts` row per `work_items` row where
-- `is_agent_task = 1`, copying `expected_output` / `acceptance_criteria` /
-- `verification_*` / `worktree_path` and linking `work_item_id`. Then point each
-- `agent_runs.contract_id` at the contract for its `parent_work_item_id`.
--
-- Deterministic ids: a backfilled contract's `id` = its source work item's id.
-- This makes the backfill idempotent (skip rows that already have a contract)
-- AND lets the agent_runs link resolve with a plain equality join. Contracts
-- created from now on get fresh ULIDs from the repo.

CREATE TABLE `agent_contracts` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `work_item_id` text,
  `agent_run_id` text,
  `attempt` integer DEFAULT 0 NOT NULL,
  `issued_by` text,
  `pod_name` text,
  `expected_output` text,
  `acceptance_criteria` text,
  `verification_tier` text,
  `verification_status` text,
  `verification_notes` text,
  `report` text,
  `deliverable` text,
  `worktree_path` text,
  `status` text DEFAULT 'issued' NOT NULL,
  `version` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_contracts_project_idx` ON `agent_contracts` (`project_id`);
--> statement-breakpoint
CREATE INDEX `agent_contracts_work_item_idx` ON `agent_contracts` (`work_item_id`);
--> statement-breakpoint
CREATE INDEX `agent_contracts_run_idx` ON `agent_contracts` (`agent_run_id`);
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `contract_id` text;
--> statement-breakpoint
CREATE INDEX `agent_runs_contract_idx` ON `agent_runs` (`contract_id`);
--> statement-breakpoint
-- Backfill one contract per is_agent_task work item. Idempotent: skip WIs that
-- already have a contract (id = the work item's id). `status` maps the legacy
-- verification_status onto the new contract lifecycle; default 'dispatched'
-- (the WI existed because a run was dispatched against it).
INSERT INTO `agent_contracts` (
  `id`, `project_id`, `work_item_id`, `agent_run_id`, `attempt`,
  `issued_by`, `pod_name`, `expected_output`, `acceptance_criteria`,
  `verification_tier`, `verification_status`, `verification_notes`,
  `report`, `deliverable`, `worktree_path`, `status`, `version`,
  `created_at`, `updated_at`
)
SELECT
  w.`id`,
  w.`project_id`,
  w.`id`,
  w.`assigned_agent_run_id`,
  0,
  NULL,
  NULL,
  w.`expected_output`,
  w.`acceptance_criteria`,
  w.`verification_tier`,
  w.`verification_status`,
  w.`verification_notes`,
  NULL,
  NULL,
  w.`worktree_path`,
  CASE
    WHEN w.`verification_status` = 'passed' THEN 'accepted'
    WHEN w.`verification_status` = 'failed' THEN 'rejected'
    WHEN w.`verification_status` = 'pending' THEN 'submitted'
    ELSE 'dispatched'
  END,
  1,
  w.`created_at`,
  w.`updated_at`
FROM `work_items` w
WHERE w.`is_agent_task` = 1
  AND w.`deleted_at` IS NULL
  AND NOT EXISTS (SELECT 1 FROM `agent_contracts` c WHERE c.`id` = w.`id`);
--> statement-breakpoint
-- Point each agent_run at the contract for its parent (contract) work item.
-- Only fill rows that aren't already linked (idempotent) and whose parent WI is
-- an agent-task contract WI (a backfilled contract row exists for it).
UPDATE `agent_runs`
SET `contract_id` = `parent_work_item_id`
WHERE `contract_id` IS NULL
  AND `parent_work_item_id` IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM `agent_contracts` c WHERE c.`id` = `agent_runs`.`parent_work_item_id`
  );
