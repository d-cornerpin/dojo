-- 199 (t200, D12): A TOOL RESULT TOO LONG FOR THE VIEW IS KEPT WHOLE, HERE.
--
-- Until now a long tool result was cut: at the producer (exec/shell kept 16,000 characters per
-- stream), at the executor (a tool's declared `maxResultTokens`), or in the view (the first ~15,000
-- tokens), and the rest was never offered to the agent. Now the stored `tool` row carries what the
-- agent sees (the result's start and end and a labelled pointer) and THIS table carries the whole,
-- which `tool_result_read` reads by line range or search.
--
--   message_id   the `tool` row that shows the pointer. Its foreign key is the lifetime rule: a
--                kept result lives exactly as long as the message row it belongs to, so every
--                path that deletes messages (agent deletion, the PM's bounded history, a reset)
--                removes it with no code of its own.
--   tool_use_id  the tool call's id, the handle the pointer names
--   agent_id     whose it is; reads are scoped to it
--   tool_name    what produced it, for the reader's header
--   content      the whole result, after credential redaction, exactly as the agent would read it
--
-- Additive only: a brand-new table, nothing read, changed or deleted, so a body of any age applies
-- it in O(1). It starts empty on purpose: results recorded before this change are whole on their
-- own `tool` rows already, and the reader reads them there instead of copying them.

CREATE TABLE IF NOT EXISTS kept_tool_results (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool_use_id TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  tool_name   TEXT,
  content     TEXT NOT NULL,
  PRIMARY KEY (message_id, tool_use_id)
);

CREATE INDEX IF NOT EXISTS idx_kept_tool_results_agent_call ON kept_tool_results(agent_id, tool_use_id);
