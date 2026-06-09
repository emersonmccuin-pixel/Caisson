-- pc-pty-chat-359 P1 — MCP Server Registry.
-- One row per registered MCP server, scoped to global or project (mirrors agents).
-- Transport carries the same stdio/HTTP shape as agent_mcp_servers.config_json.
-- discovered_tools + discoveryStatus are populated by the P2 discovery probe;
-- left NULL/'stale' in P1. Soft-delete via deleted_at.

CREATE TABLE `mcp_servers` (
  `id` text PRIMARY KEY NOT NULL,
  `scope` text NOT NULL,
  `project_id` text,
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `transport` text NOT NULL,
  `discovered_tools` text,
  `discovery_status` text NOT NULL DEFAULT 'stale',
  `rev` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
--> statement-breakpoint
CREATE INDEX `mcp_servers_scope_project_idx` ON `mcp_servers` (`scope`, `project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_global_name_idx` ON `mcp_servers` (`name`)
  WHERE scope = 'global' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_project_name_idx` ON `mcp_servers` (`project_id`, `name`)
  WHERE scope = 'project' AND deleted_at IS NULL;
