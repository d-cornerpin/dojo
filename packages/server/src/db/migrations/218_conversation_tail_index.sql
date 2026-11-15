-- 218: the conversation tail of an agent whose memory is its board (`memory/store.ts` boardAgentRows): its count
-- and its read walk only conversation rows.
CREATE INDEX IF NOT EXISTS ix_msg_conversation_seq ON messages(agent_id, seq)
  WHERE ((role = 'user' AND lane IN ('a2a', 'owner')) OR subject_kind IN ('conv', 'a2a_thread'));
