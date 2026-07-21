-- 116: execution lineage (lanes & lineage plan, phase 6a, write-only).
--
-- Tool calls, receipts, generated artifacts, and model-call costs stop being
-- agent+timestamp orphans: every execution record carries the turn that ran
-- it, the root it served, and (where one exists) the exact tool_use call id.
-- Readers switch in 6b; nothing behavioral changes in 6a.
ALTER TABLE audit_log ADD COLUMN turn_number INTEGER;
ALTER TABLE audit_log ADD COLUMN call_id TEXT;
ALTER TABLE audit_log ADD COLUMN root_kind TEXT;
ALTER TABLE audit_log ADD COLUMN root_id TEXT;

ALTER TABLE tool_receipts ADD COLUMN call_id TEXT;
ALTER TABLE tool_receipts ADD COLUMN root_kind TEXT;
ALTER TABLE tool_receipts ADD COLUMN root_id TEXT;

ALTER TABLE generation_jobs ADD COLUMN source_message_id TEXT;
ALTER TABLE generation_jobs ADD COLUMN turn_number INTEGER;
ALTER TABLE generation_jobs ADD COLUMN task_id TEXT;
ALTER TABLE generation_jobs ADD COLUMN conversation_id TEXT;
ALTER TABLE video_jobs ADD COLUMN source_message_id TEXT;
ALTER TABLE video_jobs ADD COLUMN turn_number INTEGER;
ALTER TABLE video_jobs ADD COLUMN task_id TEXT;
ALTER TABLE video_jobs ADD COLUMN conversation_id TEXT;

-- One id across the model-call triple (router decision, audit row, cost row).
ALTER TABLE cost_records ADD COLUMN request_id TEXT;
ALTER TABLE router_log ADD COLUMN request_id TEXT;
ALTER TABLE cost_records ADD COLUMN turn_number INTEGER;
ALTER TABLE router_log ADD COLUMN turn_number INTEGER;
