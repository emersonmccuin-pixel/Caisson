-- Fix: worktree-spawned agents write their CC JSONL under a worktree-keyed
-- projects/ dir, not the main project dir. Store the spawn-time worktree path
-- on the run row so the stall ladder, inspector, and events endpoint can
-- derive the correct JSONL path without falling back to project.folderPath.
ALTER TABLE `agent_runs` ADD `worktree_dir` text;
