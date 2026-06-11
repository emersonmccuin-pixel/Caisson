-- Connector-auth Slice 1 (pc-pty-chat-400.2) — credentials vault.
-- AES-256-GCM encrypted token blobs keyed to an MCP server.
-- Ciphertext, IV, and auth tag stored as base64 text.
-- owner_server_id is a soft FK to mcp_servers (no DB constraint).

CREATE TABLE `credentials` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_scope` text NOT NULL,
  `owner_server_id` text,
  `kind` text NOT NULL,
  `ciphertext` text NOT NULL,
  `iv` text NOT NULL,
  `auth_tag` text NOT NULL,
  `auth_state` text NOT NULL DEFAULT 'none',
  `last_error` text,
  `expires_at` integer,
  `rev` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `credentials_owner_server_idx` ON `credentials` (`owner_server_id`);
--> statement-breakpoint
CREATE INDEX `credentials_owner_scope_idx` ON `credentials` (`owner_scope`);
