-- M5 (FD-5 amendment, Emerson confirmed 2026-06-04) — ☠ agents.output_destination.
--
-- The column was a DEAD KNOB: written by pod create/edit routes, the settings
-- UI, and every stock-pod seed — consumed by ZERO runtime code. Results route
-- via the terminal envelope → orchestrator relay; prose placement is
-- `expectedOutput.store`. FD-5 originally said "move to the Work Contract";
-- the M5 refute downgraded that to delete (migrating a dead knob = carrying
-- rot forward). If a "send results to X" feature is wanted later it gets
-- designed on the contract in M6 as a working feature.
--
-- DESTRUCTIVE for the column's values (pod-level routing hints that nothing
-- read). Historical agent_audit rows with field='output_destination' are
-- untouched and keep rendering in the History tab.

ALTER TABLE agents DROP COLUMN output_destination;
