-- pc-pty-chat-415 (R5) — accept ⇒ land.
--
-- Landing state for accepted repo-kind contracts produced in an isolated
-- worktree. NULL = not applicable (non-repo kinds, workflow-owned runs, and
-- all pre-415 history). 'pending' is re-driven at boot; 'conflict' is the
-- durable gate a human/orchestrator resolves; receipts (branch + sha + time)
-- outlive the worktree (R15).

ALTER TABLE agent_contracts ADD COLUMN landing_status TEXT;
--> statement-breakpoint
ALTER TABLE agent_contracts ADD COLUMN landed_branch TEXT;
--> statement-breakpoint
ALTER TABLE agent_contracts ADD COLUMN landed_sha TEXT;
--> statement-breakpoint
ALTER TABLE agent_contracts ADD COLUMN landing_error TEXT;
--> statement-breakpoint
ALTER TABLE agent_contracts ADD COLUMN landed_at INTEGER;
