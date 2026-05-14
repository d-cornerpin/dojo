-- ══════════════════════════════════════════
-- A2A reply tracking — durable record of which ASSIGN/QUESTION/BLOCK
-- messages an agent has already replied to via send_to_agent.
--
-- Pre-fix, "did this agent already reply?" was derived per-handleMessage
-- call from `state.sentToAgentThisTurn` (a boolean) — which reset on every
-- new handleMessage invocation (compaction-triggered, wakeup, recovery
-- cascade, etc.). On re-entry, the loop saw the same ASSIGN as the most
-- recent user message and the missed-reply enforcer fired AGAIN, even
-- though the agent had already replied in a prior invocation. Combined
-- with the loop's hardcoded `alreadyNudgedForMissedReply: false` it
-- spiraled into the 30-nudge loop captured in loop.txt on 2026-05-13.
--
-- Now: a row is inserted whenever send_to_agent fires for a thread that
-- matches an open ASSIGN/QUESTION/BLOCK to the calling agent. The v2
-- loop's preflight checks this table and treats already-replied ASSIGNs
-- as null (no enforcer firing).
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS a2a_replies (
  assign_message_id TEXT NOT NULL,           -- the inbound A2A message the agent is replying to
  agent_id TEXT NOT NULL,                    -- the agent that sent the reply
  thread_id TEXT NOT NULL,                   -- the thread the reply went on
  reply_intent TEXT NOT NULL,                -- ANSWER, COMPLETE, FAIL, STATUS, etc.
  replied_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (assign_message_id)
);

CREATE INDEX IF NOT EXISTS idx_a2a_replies_agent ON a2a_replies(agent_id);
CREATE INDEX IF NOT EXISTS idx_a2a_replies_thread ON a2a_replies(thread_id);
