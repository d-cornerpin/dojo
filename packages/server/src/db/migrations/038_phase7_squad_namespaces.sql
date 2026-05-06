-- ════════════════════════════════════════
-- Phase 7 — squad shared memory + task completion fields
-- ════════════════════════════════════════
--
-- 1. tasks.original_description: immutable copy of the user's original ask,
--    written at createTask. Spec calls for it in Part X onTaskComplete pseudocode.
-- 2. tasks.completion_summary: structured summary captured at completion time.
--    Used by onTaskComplete to build the parent's "Completion summary:" line.
-- 3. vault_entries.namespace: scope marker. NULL = personal vault (legacy
--    semantics preserved); 'squad:<group_id>' = squad-shared. Replaces the
--    proposed separate namespaces table — leverages existing embedding
--    pipeline, retrieval, and indexing.

ALTER TABLE tasks ADD COLUMN original_description TEXT;
ALTER TABLE tasks ADD COLUMN completion_summary TEXT;

ALTER TABLE vault_entries ADD COLUMN namespace TEXT;

-- Squad recall queries scope by (namespace, agent_id is_obsolete=0).
-- Existing idx_vault_agent doesn't help when filtering by namespace first.
CREATE INDEX IF NOT EXISTS idx_vault_namespace ON vault_entries(namespace);
