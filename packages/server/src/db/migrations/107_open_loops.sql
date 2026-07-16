-- 107 (RC-2): structured, retirable open loops.
--
-- Before this, an unresolved question survived compaction ONLY as prose inside
-- an immutable summary row: it competed with everything else for salience,
-- degraded on every depth-N merge, and could NEVER be retired. That produced the
-- 7/12 poison, a transient "I couldn't read your last message" self-narration got
-- summarized into a durable obligation and re-raised to the owner five times over
-- 36 hours with no way to close it. This table moves open loops OUT of summary
-- prose into structured rows the engine can inject while open and retire on an
-- explicit signal (the agent's loop_resolve tool, a compaction RESOLVED/CLOSED
-- match, or an owner dismissal).
--
-- status:
--   'open'     still unanswered; injected every human turn while open.
--   'resolved' explicitly retired (loop_resolve, or a summary RESOLVED/CLOSED
--              match). resolved_by_message_id points at the retiring message when
--              one is known.
--   'stale'    aged past the staleness threshold WITHOUT an answer. A stale loop
--              is NOT dropped and NOT injected per turn; it is surfaced ONCE in the
--              daily brief ("still open, no answer: X, ask again or drop?") and can
--              only be closed by an explicit owner dismissal/resolution. Aging never
--              silently drops a loop (RC-2 History-check spec adjustment).
--
-- conv_key attributes the loop to the conversation it belongs to (same canonical
-- key the assembler scopes on: "owner" | "imessage:<who>" | "email:<addr>" | …),
-- so injection can show the CURRENT conversation's open loops inline and other
-- conversations' loops as a small labeled overflow. Nullable: a loop whose party
-- could not be attributed at parse time keeps NULL and surfaces as cross-conv.
--
-- source_message_id is a best-effort pointer at the message the loop was extracted
-- from (the summarized chunk's most recent row); nullable.

CREATE TABLE IF NOT EXISTS open_loops (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  conv_key TEXT,                     -- conversation this loop belongs to; NULL = unattributed
  description TEXT NOT NULL,          -- the still-unanswered question / unfulfilled request
  source_message_id TEXT,            -- best-effort provenance pointer; nullable
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'stale')),
  resolved_by_message_id TEXT,       -- set when a specific message retired the loop; nullable
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Injection reads open rows per agent (+ conv_key for the current-conversation
-- split); the briefing sweep reads stale rows per agent. Both are covered here.
CREATE INDEX IF NOT EXISTS idx_open_loops_agent_status ON open_loops(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_open_loops_agent_conv_status ON open_loops(agent_id, conv_key, status);
