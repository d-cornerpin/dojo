-- 087: C26, engine-written verification receipts for consequential actions.
--
-- "Done" / "[SENT]" today mean "the tool call returned," not "the side effect
-- landed." For a send-class action the engine assumed success the moment the
-- tool returned, and the only downstream check was an LLM (PM) reading the
-- agent's own prose evidence. On the weakest model a plausible-but-false
-- "sent it" cleared the gate. This table lets the ENGINE (never the model)
-- capture a provider-issued receipt at action time and makes the tracker
-- complete gate demand one for a turn that actually ran a send tool.
--
-- ENGINE-WRITTEN ONLY. No model-authored input ever creates or edits a row
-- here; writeToolReceipt (receipts/store.ts) is the sole writer. `detail`
-- carries JSON status/anomaly data ONLY, never message bodies, never secrets.
--
-- verified=1 only when a provider id or a read-only re-fetch confirmed the
-- effect. tier: 1 = provider id already in hand, 2 = read-only re-fetch,
-- 3 = honestly unverifiable (iMessage exit code). basis records HOW we know.

CREATE TABLE IF NOT EXISTS tool_receipts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,                -- canonical tool name (post-alias if C27 landed)
  tier INTEGER NOT NULL CHECK(tier IN (1,2,3)),
  verified INTEGER NOT NULL DEFAULT 0,   -- 1 only when a provider id / read-only re-fetch confirmed
  basis TEXT NOT NULL CHECK(basis IN ('provider-id','refetch','http-status','exit-code')),
  provider_id TEXT,                  -- Gmail message id, Twilio SID, Graph/event id, ...
  thread_id TEXT,                    -- Gmail threadId etc., NULL elsewhere
  recipient TEXT,
  detail TEXT,                       -- JSON: {status, accepted, error, htmlLink, ...}; NEVER message bodies, NEVER secrets
  audit_id TEXT,                     -- the audit_log.id the writer created alongside
  task_id TEXT,                      -- stamped by the complete gate when consumed as evidence
  sim INTEGER NOT NULL DEFAULT 0,    -- 1 = synthetic receipt from dev sim mode
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tool_receipts_agent_created ON tool_receipts(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_receipts_task ON tool_receipts(task_id);
