-- M4b (FD-8 amendment) — ☠ mailbox_messages.expires_at.
--
-- DEAD COLUMN since the table was born (0036): the one write site hard-coded
-- NULL, zero readers, no contract field, no sweep. FD-8 listed "message-expiry
-- cleanup" as M4b scope; the refute flipped it — auto-expiring messages
-- CONTRADICTS "no message silently dies" (silent loss by timer). Dead knob →
-- delete whole (0042 output_destination precedent).
--
-- DESTRUCTIVE for nothing: every live value is NULL by construction.

ALTER TABLE mailbox_messages DROP COLUMN expires_at;
