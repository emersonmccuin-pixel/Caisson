CREATE TABLE `areas` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `name` text NOT NULL,
  `summary` text DEFAULT '' NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `version` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `areas_project_idx` ON `areas` (`project_id`,`sort_order`);
--> statement-breakpoint
ALTER TABLE `work_items` ADD `area_id` text;
--> statement-breakpoint
CREATE INDEX `work_items_area_idx` ON `work_items` (`project_id`,`area_id`);
