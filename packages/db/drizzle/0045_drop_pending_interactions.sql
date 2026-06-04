-- M8 (FD-7 — Human Inbox) — retire the write-only ask-shadow layer.
--
-- `pending_interactions` only ever had ONE writer: AskShadow's best-effort
-- side-write mirroring the in-memory /api/ask resolver (kind=runtime-hook-ask).
-- The workflow/agent kinds it reserved were never written; no UI ever read it;
-- it boot-expired its own rows. FD-7 picks the mailbox user-inbox channel as
-- THE one durable human inbox — pending_asks stays as agent ask-state.
--
-- Archive-rename, not DROP (0041/0015 precedent): keeps historical shadow rows
-- for forensics. No code references the archived name.
--
-- `mailbox_messages.interaction_id` was the never-set link to that table
-- (actionableOnly filtered on it — an always-empty set). Dropped.

ALTER TABLE pending_interactions RENAME TO pending_interactions_v2_archive;--> statement-breakpoint
ALTER TABLE mailbox_messages DROP COLUMN interaction_id;
