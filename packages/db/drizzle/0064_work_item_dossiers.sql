CREATE TABLE `work_item_dossiers` (
  `work_item_id` text PRIMARY KEY NOT NULL,
  `state` text NOT NULL DEFAULT '',
  `decisions` text NOT NULL DEFAULT '',
  `open_questions` text NOT NULL DEFAULT '',
  `updated_by_run_id` text,
  `updated_by_agent` text,
  `version` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
