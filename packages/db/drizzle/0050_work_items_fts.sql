-- pc-pty-chat-254: FTS5 full-text index on work_items (title + body).
--
-- Mirrors the context_docs_fts approach (migration 0049): external-content
-- virtual table + three sync triggers. Search queries JOIN work_items and
-- filter deleted_at IS NULL so soft-deleted rows stay invisible.
--
-- NOTE: `type` filter on pc_list_work_items is deferred pending pc-pty-chat-285
-- (dual source-of-truth for work-item type — top-level `type` column vs the
-- `type` field-schema enum). Everything else from pc-pty-chat-254 is in here.

CREATE VIRTUAL TABLE `work_items_fts` USING fts5(
  title, body,
  content='work_items',
  content_rowid='rowid'
);
--> statement-breakpoint
CREATE TRIGGER `work_items_ai` AFTER INSERT ON `work_items` BEGIN
  INSERT INTO work_items_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `work_items_ad` AFTER DELETE ON `work_items` BEGIN
  INSERT INTO work_items_fts(work_items_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `work_items_au` AFTER UPDATE ON `work_items` BEGIN
  INSERT INTO work_items_fts(work_items_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO work_items_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;
--> statement-breakpoint
-- Backfill existing rows (including soft-deleted; search results JOIN + filter
-- deleted_at IS NULL). This makes existing DBs migrate cleanly.
INSERT INTO work_items_fts(rowid, title, body)
SELECT rowid, title, body FROM work_items;
