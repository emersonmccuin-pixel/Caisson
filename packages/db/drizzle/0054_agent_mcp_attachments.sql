-- pc-pty-chat-359 P3 — Agent MCP Attachments.
-- Links an agent to a registered MCP server from the registry (mcp_servers),
-- with a per-tool selection.  enabled_tools stores the literal string '*' for
-- "all tools", or a JSON-encoded string[] for a specific subset.
-- Unique index on (agent_id, mcp_server_id): one attachment per pair; PUT
-- routes upsert in-place.

CREATE TABLE `agent_mcp_attachments` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `mcp_server_id` text NOT NULL,
  `enabled_tools` text NOT NULL DEFAULT '*',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`),
  FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`id`)
);
--> statement-breakpoint
CREATE INDEX `agent_mcp_attachments_agent_idx` ON `agent_mcp_attachments` (`agent_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_mcp_attachments_unique_idx` ON `agent_mcp_attachments` (`agent_id`, `mcp_server_id`);
