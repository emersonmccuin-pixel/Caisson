-- pc-pty-chat-415 (R3) — code work is always worktree-isolated.
--
-- `isolation: "in_place"` was deleted from the repo-kind expected_output spec:
-- isolation is derived from the kind now, never chosen per dispatch. Rewrite
-- stored pod-row defaults that still spell `in_place` so the dispatch layer
-- never reads one. Historical contract rows are NOT rewritten — they are the
-- durable record of what actually ran.
--
-- Idempotent: the WHERE clause matches nothing after the first run.

UPDATE agents
SET expected_output = json_set(expected_output, '$.isolation', 'worktree')
WHERE expected_output IS NOT NULL
  AND json_extract(expected_output, '$.kind') = 'repo'
  AND json_extract(expected_output, '$.isolation') = 'in_place';
