-- Workflow-engine first-principles redesign — delivery is the sole agent
-- done-signal. Persist the epoch-ms a dispatched worker submitted its
-- deliverable (pc_submit_deliverable). A contract-first run that reaches a
-- terminal without this set is a `no-deliverable` failure, not an empty
-- "completed". NULL for runs that never delivered.
ALTER TABLE `agent_runs` ADD `delivered_at` integer;
