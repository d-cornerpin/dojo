-- 106 (RC-12): conversation + turn + sent-text context on delivery receipts.
--
-- The tool_receipts ledger (migration 087) records that a send happened (tool,
-- recipient, verified, created_at) but not WHICH conversation it belonged to,
-- WHICH turn produced it, or WHAT was sent. RC-1 / RC-12 need all three:
--
--   conv_key    the conversation the send was made from (the turn's counterparty
--               conv_key). Lets the delivery-claim guard and the RECENT OUTBOUND
--               block attribute a send to the lane it belongs to. Engine-written,
--               resolved from the live turn state, never model input.
--   turn_number the outer turn that produced the send (provenance / correlation).
--   sent_text   a bounded copy of what was sent (imessage/sms: the message body;
--               email: subject + first 300 chars of body), so the pending-question
--               header can quote the agent's own most-recent question back to it on
--               the next turn (the RC-1 "bare-number answer is unbindable" fix).
--               Engine-written, bounded, never a secret store (the same body is
--               already in the messages tool_use args); NEVER credentials.
--
-- All three are nullable: legacy receipts and receipts written outside a turn keep
-- NULL. writeToolReceipt (receipts/store.ts) fills them going forward. No
-- created_at/updated_at here (the table already carries both from migration 087).

ALTER TABLE tool_receipts ADD COLUMN conv_key TEXT;
ALTER TABLE tool_receipts ADD COLUMN turn_number INTEGER;
ALTER TABLE tool_receipts ADD COLUMN sent_text TEXT;

-- The delivery-claim guard + RECENT OUTBOUND block query recent receipts per agent
-- ordered by time; migration 087 already indexes (agent_id, created_at), which
-- covers those reads. A recipient-scoped lookup (findRecentDeliveries) filters the
-- same agent+time window in JS after the indexed read, so no extra index is needed.
