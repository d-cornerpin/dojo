-- v3.0.9 — Structured inbound routing metadata.
--
-- Channel producers (the mail/Teams watchers, the Twilio SMS/voice inbound
-- handlers, the iMessage bridge, and the voice pipeline) stamp this JSON
-- onto the inbound user message so the engine routes the reply off reliable
-- structured data instead of re-parsing the human-readable [SOURCE: ...]
-- prose. Shape = @dojo/shared InboundMeta. NULL for messages that predate
-- this column or that no producer stamped (the engine falls back to parsing
-- the prose marker, preserving old behavior).
ALTER TABLE messages ADD COLUMN inbound_meta TEXT DEFAULT NULL;
