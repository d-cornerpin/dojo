-- D-A inter-agent physical store (step 1 of the inter-agent lane re-architecture).
--
-- Owner decision D-A (DOJO-ISSUES-LOG.md, 2026-07-05): inter-agent (A2A) traffic
-- gets its OWN physical store, not the tag-and-filter overlay, so A2A messages can
-- never live in the primary's chat table where a forgetful downstream filter could
-- leak them into human chat. This table is the new physical home for peer A2A
-- inbound rows that deliverA2AMessage used to write into `messages`.
--
-- Columns mirror the A2A-relevant columns of `messages` EXACTLY (same names, same
-- meaning) so the row mapper (rowToMessage) and origin projection (deriveOrigin)
-- stay unchanged and the merged model tail comes out byte-identical, protecting the
-- correctness floor (DeepSeek V4 Flash). Columns `messages` carries that are NOT
-- A2A-relevant (token_count/model_id/cost/latency_ms/reasoning_content/source/
-- inbound_meta/swept_at/delivery_attempts/next_attempt_at) are intentionally absent;
-- the merged loaders project them as NULL, which is exactly the value peer A2A rows
-- carry in `messages` today.
CREATE TABLE IF NOT EXISTS inter_agent_messages (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,                 -- recipient (the woken agent), mirrors messages.agent_id
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  source_agent_id TEXT,                   -- sender (mig 027 parity)
  a2a_thread_id TEXT,                     -- mig 034 parity
  a2a_intent TEXT,                        -- mig 034 parity
  a2a_requires_response INTEGER,          -- mig 034 parity
  attachments TEXT,                       -- mig 011 parity (JSON array or NULL)
  origin_kind TEXT DEFAULT NULL,          -- mig 075 parity (NULL = peer A2A; 'engine' rows stay in messages for now)
  origin_intent TEXT DEFAULT NULL,        -- mig 075 parity
  conv_key TEXT DEFAULT NULL,             -- mig 076 parity (park:<thread> / claim sentinels)
  turn_number INTEGER,                    -- mig 037 parity
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Indexes per the plan. NB: SQLite rejects an explicit `rowid` column in a
-- CREATE INDEX column list ("no such column: rowid"); every SQLite index already
-- carries the rowid implicitly as its lookup/tiebreak key, so (agent_id, created_at)
-- delivers the intended (agent_id, created_at, rowid) ordering for free.
CREATE INDEX IF NOT EXISTS idx_ia_messages_agent_created ON inter_agent_messages(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ia_messages_thread ON inter_agent_messages(agent_id, a2a_thread_id);
CREATE INDEX IF NOT EXISTS idx_ia_messages_source ON inter_agent_messages(source_agent_id);

-- ── Live-edge backfill ──
-- Copy ONLY the live edge into the store so the reply-owed machinery (which is
-- re-pointed to read the store) and the merged tail keep seeing in-flight work
-- across the persist cutover (this mitigates a peer A2A row that landed in
-- `messages` moments before the cutover). Historical, already-replied A2A rows
-- stay inert in `messages` (an optional later swept-marker migration can retire
-- them). Scope is PEER A2A only (origin_kind IS NULL); engine-origin A2A stays in
-- `messages` until the engine-notice writers move (fast-follow), because
-- getPendingEngineEvent still reads `messages` for engine turns.
--
-- INSERT OR IGNORE + a fresh empty table means this is idempotent and copy-only:
-- backfilled rows continue to exist in `messages` too, so every interim reader
-- still on `messages` (park SELECTs, counterparty, the assembler paths not yet
-- switched) is unaffected. The merged loaders dedup the messages side against
-- these store ids, so a backfilled row is never double-counted.
INSERT OR IGNORE INTO inter_agent_messages
  (id, agent_id, role, content, source_agent_id, a2a_thread_id, a2a_intent,
   a2a_requires_response, attachments, origin_kind, origin_intent, conv_key,
   turn_number, created_at)
SELECT
  m.id, m.agent_id, m.role, m.content, m.source_agent_id, m.a2a_thread_id, m.a2a_intent,
  m.a2a_requires_response, m.attachments, m.origin_kind, m.origin_intent, m.conv_key,
  m.turn_number, m.created_at
FROM messages m
WHERE m.role = 'user'
  AND m.created_at >= datetime('now', '-14 days')
  AND (
    -- (a) unreplied reply-needed peer A2A (the open ASSIGN/QUESTION/BLOCK edge)
    (m.origin_kind IS NULL
      AND m.a2a_thread_id IS NOT NULL
      AND m.a2a_intent IN ('QUESTION', 'ASSIGN', 'BLOCK')
      AND m.id NOT IN (SELECT assign_message_id FROM a2a_replies))
    OR
    -- (b) a peer terminal-wake deliverable that has not yet been claimed by a turn
    (m.origin_kind IS NULL
      AND m.a2a_thread_id IS NOT NULL
      AND m.a2a_intent IN ('DELIVERABLE', 'ANSWER', 'COMPLETE', 'FAIL')
      AND m.a2a_requires_response = 1
      AND m.conv_key IS NULL)
    OR
    -- (c) open parks (an owner question awaiting an agent's reply, not yet relayed)
    (m.conv_key LIKE 'park:%')
  );
