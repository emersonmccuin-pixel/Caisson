-- pc-pty-chat-359 P4b — Migrate inline agent_mcp_servers rows to the registry.
--
-- Strategy: one mcp_servers entry per unique (scope, project_id, name) — chosen
-- deterministically as the row whose id sorts first lexicographically (MIN).
-- Every agent_mcp_servers row gets an agent_mcp_attachments link pointing at
-- the canonical registry entry. enabledTools defaults to '*' (the inline path
-- had no per-tool scoping).
--
-- Both INSERTs use OR IGNORE so the migration is safe to re-run and handles
-- the case where some servers were already attached via the P3 UI.
--
-- Step 3 drops the old table — the code no longer references it.

-- Step 1: one registry entry per unique (scope, project_id, name).
-- The canonical id = the agent_mcp_servers.id of the MIN(id) row for that name.
INSERT OR IGNORE INTO mcp_servers (
  id, scope, project_id, name, description, transport,
  discovered_tools, discovery_status, rev, created_at, updated_at
)
SELECT
  src.id,
  src.scope,
  src.project_id,
  src.name,
  '',
  src.config_json,
  NULL,
  'stale',
  0,
  src.created_at,
  src.created_at
FROM agent_mcp_servers src
WHERE src.id = (
  SELECT MIN(sub.id)
  FROM agent_mcp_servers sub
  WHERE sub.scope    = src.scope
    AND sub.project_id IS src.project_id
    AND sub.name     = src.name
);
--> statement-breakpoint
-- Step 2: one attachment row per agent_mcp_servers row, pointing at the
-- canonical mcp_servers entry for that (scope, project_id, name).
INSERT OR IGNORE INTO agent_mcp_attachments (
  id, agent_id, mcp_server_id, enabled_tools, created_at, updated_at
)
SELECT
  ams.id,
  ams.agent_id,
  (
    SELECT ms.id
    FROM   mcp_servers ms
    WHERE  ms.scope      = ams.scope
      AND  ms.project_id IS ams.project_id
      AND  ms.name       = ams.name
      AND  ms.deleted_at IS NULL
    LIMIT 1
  ),
  '*',
  ams.created_at,
  ams.created_at
FROM agent_mcp_servers ams
WHERE EXISTS (SELECT 1 FROM agents a WHERE a.id = ams.agent_id);
--> statement-breakpoint
-- Step 3: drop the old inline table.
DROP TABLE IF EXISTS agent_mcp_servers;
