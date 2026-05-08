-- ════════════════════════════════════════
-- Messages: persist reasoning_content for thinking-mode providers
-- ════════════════════════════════════════
--
-- Some providers (DeepSeek v4-pro, others) return the model's chain of
-- thought as a sibling field of `content` on assistant messages — not
-- inside the content array like Anthropic. The DOJO assembles assistant
-- messages from the messages table for every subsequent request, and
-- DeepSeek explicitly requires `reasoning_content` to be passed back on
-- tool-call follow-up turns (or it returns 400). We persist it here so
-- the assembly path can round-trip it.
--
-- Nullable: only thinking-mode responses populate this. Pre-existing
-- rows and non-thinking provider rows leave it NULL.

ALTER TABLE messages ADD COLUMN reasoning_content TEXT;
