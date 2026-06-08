-- pc-pty-chat-333: per-project notes scratchpad.
-- Simple nullable TEXT column; existing rows default to NULL (no notes).
ALTER TABLE `projects` ADD COLUMN `notes` text;
