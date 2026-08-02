-- 154 (PHASE-5 T3): EXEC BECOMES TWO DOORS, AND APPLESCRIPT BECOMES ITS OWN.
--
-- WHAT CHANGES. `grant_rule.effect_kind`'s CHECK constraint listed seven kinds
-- (migration 153). T3 splits the one exec door into two and lifts osascript out
-- of `system_control`, so three names join the vocabulary:
--
--   'proc'         `exec({argv})` — a program and literal arguments, no shell.
--                  Projected from `exec_allow` / `exec_deny`.
--   'shell'        (already present, meaning narrowed) `shell({script})` under
--                  /bin/zsh. Projected from `shell_allow` when the manifest
--                  declares it, and from `exec_allow` when it does not — which
--                  is the migration for every manifest written before today.
--   'applescript'  `applescript_run`. Projected from `system_control`: a `'*'`
--                  grant still covers it, a LIST must name it. That is exactly
--                  what the ladder's category derivation already required, so
--                  no live manifest changes meaning.
--
-- ── WHY THIS IS A DROP-AND-RECREATE AND WHY THAT IS SAFE HERE ──
-- SQLite cannot ALTER a CHECK constraint. Migration 153's own header sets the
-- precedent and states the reason this table may be dropped where others may
-- not: EVERY ROW IS DERIVABLE. A `grant_rule` row is a projection of
-- `agents.permissions` stamped with the fingerprint it was projected from, and
-- `brokers/grants.ts:grantFor()` re-projects the instant a stored fingerprint
-- does not match. Dropping costs one re-projection per agent on its next
-- authorize and nothing else — there is no state in this table that is not
-- derivable, by design.
--
-- ── AND WHY IT IS `DROP TABLE IF EXISTS` FIRST, NOT `CREATE IF NOT EXISTS` ──
-- 153 was written the other way round and the ADVERSARIAL rehearsal body killed
-- it: `CREATE TABLE IF NOT EXISTS` was a NO-OP against a pre-existing loose
-- table, so a box would have recorded the migration as applied while carrying
-- NONE of its constraints, and the UNIQUE index then aborted the chain on the
-- planted duplicates. Same shape, same fix, same rehearsal owed (roadmap #16):
-- this file is rehearsed against a clean body, the real dev body, and a body
-- carrying a LOOSE `grant_rule` before it is trusted.
--
-- ⚠ A BOX THAT HAS ALREADY APPLIED 153 CARRIES ROWS WITH `effect_kind='shell'`
-- MEANING "the exec allowlist". After this migration the table is empty and the
-- next authorize re-projects, which writes BOTH 'proc' and 'shell' rows from the
-- same `exec_allow`. The old rows are not migrated in place because they cannot
-- be: their fingerprint is right and their meaning is not, and a fingerprint
-- match is precisely what would stop the re-projection from happening.
DROP TABLE IF EXISTS grant_rule;

CREATE TABLE grant_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  -- The broker vocabulary, not the manifest's field names: one row says what an
  -- agent may do to a KIND of resource, which is the thing `authorize()` asks.
  effect_kind TEXT NOT NULL CHECK (effect_kind IN (
    'fs_read', 'fs_write', 'fs_delete',
    'proc', 'shell', 'applescript',
    'net', 'spawn', 'system_control'
  )),
  mode TEXT NOT NULL CHECK (mode IN ('allow', 'deny')),
  -- A glob for paths and commands, a domain suffix for `net`, `'*'` for the
  -- unrestricted grant. Never NULL: a rule with no pattern matches nothing and
  -- would read as a rule that does something.
  pattern TEXT NOT NULL,
  -- Where the rule came from. Only 'manifest' exists today; T5 adds the
  -- validated shapes and this column is what tells them apart.
  source TEXT NOT NULL DEFAULT 'manifest',
  -- sha256(the manifest these rows were projected from), first 32 hex chars.
  manifest_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- The read path, exactly: one agent, one kind, deny before allow.
CREATE INDEX grant_rule_lookup
  ON grant_rule (agent_id, effect_kind, mode DESC);

-- A duplicated rule is a defect, not a merge: two identical rows mean the
-- projection ran twice and the second run did not clean up after the first.
CREATE UNIQUE INDEX grant_rule_unique
  ON grant_rule (agent_id, effect_kind, mode, pattern, source);
