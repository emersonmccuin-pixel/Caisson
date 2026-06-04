-- M4a (FD-12 bypass #3 EXECUTED / ledger row 9) — retire the pre-mailbox
-- delivery durability layer.
--
-- `agent_inbox` + `agent_delivery_audit` lost their last writer in slice 017
-- Phase C (enqueueAndPush -> mailbox cutover); since then the only living code
-- was the `inbox-drain.cjs` UserPromptSubmit hook raw-SQLing an eternally-empty
-- pending set on every prompt (deleted with this migration). The mailbox
-- (mailbox_messages/recipients/deliveries + the worker) is the ONE delivery
-- system.
--
-- Archive-rename, not DROP (the 0015 Phase-D precedent): preserves the ~250
-- historical delivered rows + the 15 pre-cutover pending stragglers for
-- forensics. No code references the archived names.

ALTER TABLE agent_inbox RENAME TO agent_inbox_v2_archive;--> statement-breakpoint
ALTER TABLE agent_delivery_audit RENAME TO agent_delivery_audit_v2_archive;
