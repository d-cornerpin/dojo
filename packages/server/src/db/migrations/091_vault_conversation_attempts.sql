-- 091 (FA-V4): bounded per-archive Dreamer retry + poison escalation.
--
-- Multi-batch dream cycles used to advance ONLY on complete_task status
-- 'complete', and the batch chain lived in an in-memory Map. A batch that
-- ended 'blocked'/'fallen', or any process restart mid-cycle, stalled the
-- whole night with no dream report and no alarm. The continuation is now
-- stateless (re-derived from the DB), and a non-complete batch no longer
-- stalls: each archive it failed to distill gets attempts++ and, after a
-- bounded number of tries (MAX_DREAM_ATTEMPTS in maintenance.ts), is marked
-- poisoned so the engine stops retrying it forever and surfaces it loudly.
--
--   attempts       count of terminal-but-not-complete Dreamer passes over this
--                  archive (bounded retry). No reset is needed: a 'complete'
--                  pass flips is_processed=1 and the row leaves the pipeline.
--   poisoned       1 once attempts crossed the cap without a distill. A poisoned
--                  archive is NEVER marked is_processed (it was never distilled,
--                  so that would be a lie). Instead it is excluded from the
--                  Dreamer's work queue (getUnprocessedConversations), from the
--                  backlog count (getVaultStats), and from the DREAM_STALE age
--                  signal, and is surfaced by its own Healer diagnostic
--                  (DREAM_POISONED).
--   poisoned_at    when the escalation fired (for the diagnostic + audit).
--   poison_reason  plain-language reason recorded at escalation time.
ALTER TABLE vault_conversations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vault_conversations ADD COLUMN poisoned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vault_conversations ADD COLUMN poisoned_at TEXT;
ALTER TABLE vault_conversations ADD COLUMN poison_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_vault_conv_poisoned ON vault_conversations(poisoned);
