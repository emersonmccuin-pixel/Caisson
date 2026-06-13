-- pc-pty-chat-409 / pc-pty-chat-408 Phase 1 — Shared global agents: membership.
--
-- Three changes in one migration (must stay atomic):
--   1. CREATE TABLE agent_projects — one row per (agent, project) pair.
--   2. ALTER TABLE agents ADD COLUMN shareable — NOT NULL DEFAULT 0.
--   3. Data migration:
--      a. scope='project' live agents → one membership row each.
--      b. scope='global', origin='user-created' agents → shareable=1.
--   4. agent_secrets re-key:
--      a. Dedupe rows that would collide under (agent_id, env_var_name).
--      b. Drop the old scope-split partial unique indices.
--      c. Create the new unconditional unique index on (agent_id, env_var_name).

-- ── 1. agent_projects join table ─────────────────────────────────────────────

CREATE TABLE `agent_projects` (
  `agent_id` text NOT NULL,
  `project_id` text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`agent_id`, `project_id`),
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`),
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
--> statement-breakpoint
CREATE INDEX `agent_projects_project_idx` ON `agent_projects` (`project_id`);
--> statement-breakpoint

-- ── 2. agents.shareable column ────────────────────────────────────────────────

ALTER TABLE `agents` ADD COLUMN `shareable` integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- ── 3a. Membership rows for scope='project' agents ───────────────────────────
-- Inserts one row per live project-scoped agent into agent_projects.
-- Stock globals (origin='stock') and user-created globals get no rows here.

INSERT INTO agent_projects (agent_id, project_id, created_at)
SELECT id, project_id, created_at
FROM   agents
WHERE  scope      = 'project'
  AND  project_id IS NOT NULL
  AND  deleted_at IS NULL;
--> statement-breakpoint

-- ── 3b. Mark user-created globals as shareable ───────────────────────────────

UPDATE agents
SET    shareable = 1
WHERE  scope  = 'global'
  AND  origin = 'user-created';
--> statement-breakpoint

-- ── 4a. Dedupe agent_secrets — keep the most-recent row per (agent_id, env_var_name).
-- ULIDs are time-ordered so MAX(id) == most recent.

DELETE FROM agent_secrets
WHERE id NOT IN (
  SELECT MAX(id)
  FROM   agent_secrets
  GROUP  BY agent_id, env_var_name
);
--> statement-breakpoint

-- ── 4b. Drop old scope-split partial unique indices ───────────────────────────

DROP INDEX IF EXISTS `agent_secrets_global_env_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `agent_secrets_project_env_idx`;
--> statement-breakpoint

-- ── 4c. New unconditional unique index on (agent_id, env_var_name) ───────────

CREATE UNIQUE INDEX `agent_secrets_env_idx` ON `agent_secrets` (`agent_id`, `env_var_name`);
