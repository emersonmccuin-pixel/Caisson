-- Command: focus flag on projects / areas / work items. The planner stars
-- things; NULL = not in focus, set = epoch-ms it was focused. Binary on/off in
-- practice (timestamp doubles as a "most-recently focused" sort key). All
-- existing rows default to NULL.
ALTER TABLE `projects` ADD COLUMN `focused_at` integer;
--> statement-breakpoint
ALTER TABLE `areas` ADD COLUMN `focused_at` integer;
--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `focused_at` integer;
