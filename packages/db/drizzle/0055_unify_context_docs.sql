-- Unify the two doc systems: agent_knowledge merges INTO context_docs as a
-- 4th scope pointer (agent_id). One table, one search, one lifecycle.
--
-- Table rebuild (SQLite cannot ALTER a CHECK constraint): FTS + triggers are
-- dropped first and recreated after ALL inserts, then a single
-- INSERT INTO context_docs_fts(context_docs_fts) VALUES('rebuild') re-indexes
-- the whole content table — copied rows and migrated rows alike — without
-- depending on trigger firing order.
--
-- Data mapping from agent_knowledge: id preserved (agent_audit.field_ref
-- continuity), kind folds into the title (name + ' (example)'), per-row
-- scope/project_id dropped (redundant with the agent row's own scope).

DROP TRIGGER `context_docs_ai`;
--> statement-breakpoint
DROP TRIGGER `context_docs_ad`;
--> statement-breakpoint
DROP TRIGGER `context_docs_au`;
--> statement-breakpoint
DROP TABLE `context_docs_fts`;
--> statement-breakpoint

CREATE TABLE `context_docs_new` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text,
  `area_id` text,
  `work_item_id` text,
  `agent_id` text,
  `title` text NOT NULL,
  `body` text NOT NULL DEFAULT '',
  `author` text NOT NULL DEFAULT 'user',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer,
  CHECK (
    (CASE WHEN project_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN area_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN work_item_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN agent_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);
--> statement-breakpoint
INSERT INTO `context_docs_new`
  (`id`, `project_id`, `area_id`, `work_item_id`, `agent_id`, `title`, `body`, `author`, `created_at`, `updated_at`, `deleted_at`)
  SELECT `id`, `project_id`, `area_id`, `work_item_id`, NULL, `title`, `body`, `author`, `created_at`, `updated_at`, `deleted_at`
  FROM `context_docs`;
--> statement-breakpoint
DROP TABLE `context_docs`;
--> statement-breakpoint
ALTER TABLE `context_docs_new` RENAME TO `context_docs`;
--> statement-breakpoint

CREATE INDEX `context_docs_project_idx` ON `context_docs` (`project_id`);
--> statement-breakpoint
CREATE INDEX `context_docs_area_idx` ON `context_docs` (`area_id`);
--> statement-breakpoint
CREATE INDEX `context_docs_work_item_idx` ON `context_docs` (`work_item_id`);
--> statement-breakpoint
CREATE INDEX `context_docs_agent_idx` ON `context_docs` (`agent_id`);
--> statement-breakpoint

INSERT INTO `context_docs`
  (`id`, `agent_id`, `title`, `body`, `author`, `created_at`, `updated_at`)
  SELECT `id`, `agent_id`,
         CASE WHEN `kind` = 'example' THEN `name` || ' (example)' ELSE `name` END,
         `content`, 'user', `created_at`, `updated_at`
  FROM `agent_knowledge`;
--> statement-breakpoint

DROP TABLE `agent_knowledge`;
--> statement-breakpoint

CREATE VIRTUAL TABLE `context_docs_fts` USING fts5(
  title, body,
  content='context_docs',
  content_rowid='rowid'
);
--> statement-breakpoint
CREATE TRIGGER `context_docs_ai` AFTER INSERT ON `context_docs` BEGIN
  INSERT INTO context_docs_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `context_docs_ad` AFTER DELETE ON `context_docs` BEGIN
  INSERT INTO context_docs_fts(context_docs_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `context_docs_au` AFTER UPDATE ON `context_docs` BEGIN
  INSERT INTO context_docs_fts(context_docs_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO context_docs_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;
--> statement-breakpoint
INSERT INTO context_docs_fts(context_docs_fts) VALUES('rebuild');
