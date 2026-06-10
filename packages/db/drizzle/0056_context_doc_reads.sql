-- Read receipts for context docs (staleness/usage tracking).
--
-- One row per "a session actually consumed this doc": either its body was
-- inlined into an agent's spawn prompt by the context chain ('injection'),
-- or it was fetched at runtime via pc_get_context_doc ('tool'). UI fetches
-- are never recorded. No FKs by design: reads are history and must survive
-- doc soft-delete and run pruning.

CREATE TABLE `context_doc_reads` (
  `id` text PRIMARY KEY NOT NULL,
  `doc_id` text NOT NULL,
  `agent_run_id` text,
  `session_kind` text NOT NULL,
  `read_via` text NOT NULL,
  `read_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_doc_reads_doc_idx` ON `context_doc_reads` (`doc_id`, `read_at`);
--> statement-breakpoint
CREATE INDEX `context_doc_reads_run_idx` ON `context_doc_reads` (`agent_run_id`);
