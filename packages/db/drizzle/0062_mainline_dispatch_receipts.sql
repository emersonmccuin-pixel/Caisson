ALTER TABLE `agent_runs` ADD COLUMN `worktree_base_branch` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD COLUMN `worktree_base_sha` text;--> statement-breakpoint
ALTER TABLE `agent_contracts` ADD COLUMN `worktree_base_branch` text;--> statement-breakpoint
ALTER TABLE `agent_contracts` ADD COLUMN `worktree_base_sha` text;--> statement-breakpoint
ALTER TABLE `workflow_runs_v2` ADD COLUMN `worktree_base_branch` text;--> statement-breakpoint
ALTER TABLE `workflow_runs_v2` ADD COLUMN `worktree_base_sha` text;
