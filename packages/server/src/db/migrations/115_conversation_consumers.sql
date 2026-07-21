-- 115: conversation identity reaches the consumers (lanes & lineage P5b).
--
-- open_loops: loops belong to conversations by KEY now (the heuristic
-- dominant-conv attribution becomes the fallback), and answered_at records
-- WHEN a loop was satisfied instead of leaving lifecycle to inference.
ALTER TABLE open_loops ADD COLUMN conversation_id TEXT;
ALTER TABLE open_loops ADD COLUMN answered_at TEXT;

-- Summaries and archives finally CARRY lineage instead of dropping it at the
-- compaction boundary: the dominant conversation of the summarized chunk and
-- its thread, so recall and audits can follow identity through compression.
ALTER TABLE summaries ADD COLUMN conversation_id TEXT;
ALTER TABLE summaries ADD COLUMN conv_key TEXT;
ALTER TABLE summaries ADD COLUMN a2a_thread_id TEXT;
ALTER TABLE vault_conversations ADD COLUMN conversation_id TEXT;
