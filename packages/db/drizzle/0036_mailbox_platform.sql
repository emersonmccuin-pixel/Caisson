CREATE TABLE `pending_interactions` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `kind` text NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,
  `source_kind` text NOT NULL,
  `source_id` text NOT NULL,
  `source_ref` text,
  `prompt` text NOT NULL,
  `context` text,
  `options` text,
  `answer_body` text,
  `answered_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `answered_at` integer,
  `cancelled_at` integer,
  `expires_at` integer,
  `version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_interactions_project_idx` ON `pending_interactions` (`project_id`, `status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `pending_interactions_source_idx` ON `pending_interactions` (`source_kind`, `source_id`);
--> statement-breakpoint
CREATE INDEX `pending_interactions_kind_idx` ON `pending_interactions` (`kind`, `status`);
--> statement-breakpoint
CREATE TABLE `mailbox_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text,
  `kind` text NOT NULL,
  `subject` text,
  `body` text NOT NULL,
  `payload` text DEFAULT '{}' NOT NULL,
  `source_kind` text NOT NULL,
  `source_id` text,
  `interaction_id` text,
  `idempotency_key` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_messages_idempotency_idx` ON `mailbox_messages` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `mailbox_messages_project_idx` ON `mailbox_messages` (`project_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `mailbox_recipients` (
  `id` text PRIMARY KEY NOT NULL,
  `message_id` text NOT NULL,
  `address_kind` text NOT NULL,
  `address_json` text NOT NULL,
  `read_at` integer,
  `actioned_at` integer,
  `dismissed_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mailbox_recipients_message_idx` ON `mailbox_recipients` (`address_kind`, `message_id`);
--> statement-breakpoint
CREATE INDEX `mailbox_recipients_unread_idx` ON `mailbox_recipients` (`address_kind`, `read_at`);
--> statement-breakpoint
CREATE TABLE `mailbox_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `message_id` text NOT NULL,
  `recipient_id` text NOT NULL,
  `channel` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `lease_owner` text,
  `lease_expires_at` integer,
  `attempts` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` integer,
  `target_ref_kind` text,
  `target_ref_id` text,
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `accepted_at` integer,
  `failed_at` integer
);
--> statement-breakpoint
CREATE INDEX `mailbox_deliveries_status_idx` ON `mailbox_deliveries` (`status`, `next_attempt_at`);
--> statement-breakpoint
CREATE INDEX `mailbox_deliveries_recipient_idx` ON `mailbox_deliveries` (`recipient_id`, `status`);
--> statement-breakpoint
CREATE INDEX `mailbox_deliveries_target_idx` ON `mailbox_deliveries` (`target_ref_kind`, `target_ref_id`);
--> statement-breakpoint
CREATE TABLE `mailbox_dead_letters` (
  `id` text PRIMARY KEY NOT NULL,
  `message_id` text NOT NULL,
  `recipient_id` text,
  `delivery_id` text,
  `reason` text NOT NULL,
  `last_error` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mailbox_dead_letters_message_idx` ON `mailbox_dead_letters` (`message_id`);
--> statement-breakpoint
CREATE TABLE `mailbox_audit` (
  `id` text PRIMARY KEY NOT NULL,
  `message_id` text,
  `recipient_id` text,
  `delivery_id` text,
  `action` text NOT NULL,
  `actor_kind` text NOT NULL,
  `actor_id` text,
  `details` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mailbox_audit_message_idx` ON `mailbox_audit` (`message_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `mailbox_audit_delivery_idx` ON `mailbox_audit` (`delivery_id`, `created_at`);
