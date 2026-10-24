-- 206 (v3.5, Harness² §K37): REPEATING TOOL ERRORS ARE COUNTED ACROSS AGENTS.
--
-- `agent_tool_failures` (067) counts per agent and call signature and keeps no error text;
-- `agent_tool_outcomes` (195) keeps the last error per agent and tool. Nothing counted the same
-- error TEXT across agents, so "five agents all guessed the same wrong label" was five private
-- facts instead of one visible one.
--
-- One row per (tool, fingerprint). `fingerprint` is the error text with ids, uuids, paths,
-- numbers and addresses masked (agent/v2/error-fingerprint.ts), so two agents' identical
-- failures land on one row. `sample` is the first error text seen. `agents` is a JSON array of
-- the distinct agent ids that hit it. Instants are epoch milliseconds.
--
-- Additive only: a brand-new table, nothing read, changed or deleted, so a body of any age
-- applies it in O(1). It starts empty on purpose; history is not reconstructed.
-- CREATE TABLE IF NOT EXISTS is a no-op on a body that already carries a table of this name.

CREATE TABLE IF NOT EXISTS tool_error_signatures (
  tool        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  sample      TEXT NOT NULL,
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 1,
  agents      TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (tool, fingerprint)
);
