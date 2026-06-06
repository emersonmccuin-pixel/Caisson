-- Slice 1 (Areas + context model) — context_docs base table + FTS5 virtual
-- table + three sync triggers.
--
-- Scope pointer rule: exactly one of (project_id, area_id, work_item_id) MUST
-- be non-null. The CHECK enforces this at the SQL level; the repo writer also
-- enforces it in app code (belt-and-suspenders, since Drizzle doesn't run CHECKs).
--
-- FTS5 stays outside Drizzle (virtual tables are unsupported by the ORM).
-- All FTS reads/writes go through getRawDb().

CREATE TABLE `context_docs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text,
  `area_id` text,
  `work_item_id` text,
  `title` text NOT NULL,
  `body` text NOT NULL DEFAULT '',
  `author` text NOT NULL DEFAULT 'user',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer,
  CHECK (
    (CASE WHEN project_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN area_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN work_item_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);
--> statement-breakpoint
CREATE INDEX `context_docs_project_idx` ON `context_docs` (`project_id`);
--> statement-breakpoint
CREATE INDEX `context_docs_area_idx` ON `context_docs` (`area_id`);
--> statement-breakpoint
CREATE INDEX `context_docs_work_item_idx` ON `context_docs` (`work_item_id`);
--> statement-breakpoint

-- FTS5 external-content table. content= references context_docs; the three
-- sync triggers keep the index consistent with the base table.
-- Soft-deleted rows remain in the FTS index until a hard DELETE fires;
-- search results always JOIN context_docs and filter deleted_at IS NULL.
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
