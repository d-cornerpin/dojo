-- 153 (PHASE-5 T2): A GRANT BECOMES ROWS, AND DENY-WINS BECOMES A QUERY.
--
-- WHAT THIS REPLACES. Until now a grant was a JSON blob in `agents.permissions`
-- read by six hand-written `check*` functions in `agent/permissions.ts`, each
-- with its own order of operations. The order is where the bugs lived, and the
-- tree already carries one in a comment: the squad-workspace fallback re-opened
-- a path the global deny had shut, and the fix was to REMEMBER to re-apply the
-- deny inside the fallback (`permissions.ts`, FA-P5). "Remember to re-apply the
-- deny" is not a design; it is a bug waiting for a tired afternoon.
--
-- A `grant_rule` row is `{agent_id, effect_kind, mode, pattern}` and the brokers
-- read it `ORDER BY mode DESC` — `'deny' > 'allow'` lexicographically, so every
-- deny is evaluated before every allow and **deny-wins is a property of the
-- query rather than of anybody's discipline.** The UNIQUE index below makes a
-- duplicated rule unrepresentable, which is the other half of the same idea.
--
-- ── WHY THERE IS NO SQL BACKFILL, STATED PLAINLY (roadmap #16) ──
-- The obvious shape for this migration is `INSERT … SELECT json_extract(...)
-- FROM agents`, and it was written, rehearsed and REJECTED on the evidence.
-- Every row carries `manifest_fingerprint`, a sha256 of the manifest the row was
-- projected from; `brokers/grants.ts:grantFor()` re-projects the instant a
-- stored fingerprint does not match the live manifest's, which is exactly what
-- makes drift between the blob and the rows structurally impossible. SQLite
-- cannot compute that fingerprint, so every backfilled row would carry a
-- placeholder, and the first authorize for each agent would delete and rewrite
-- all of them. A backfill whose entire output is discarded on first read is not
-- a backfill; it is a slower empty table. So the table starts EMPTY and fills
-- itself agent by agent, through the ONE projection function that also computes
-- the fingerprint. Non-negotiable #15's sibling: an empty table here is not a
-- dead table — its writer is named, live, and on the hot path.
--
-- ── WHAT IS DELIBERATELY *NOT* IN THIS TABLE ──
-- The GLOBAL deny list. `~/.dojo/secrets.yaml`, the SSH keys, the platform
-- database, the sensei souls: those stay hard-coded in `agent/brokers/deny.ts`,
-- unoverridable, exactly as the four lists they were merged from were. A row is
-- something a `DELETE` can remove; the platform's strongest protections must not
-- be. This migration deliberately makes grants configurable and denies not.
--
-- ── ON `ON DELETE CASCADE` ──
-- `PRAGMA foreign_keys` is per-connection and OFF for the whole migration chain
-- (migration 151's header measured exactly this), so the cascade is a tidiness
-- guarantee at runtime and not a correctness one. Correctness does not depend on
-- it: a row for a deleted agent is unreachable, because every read starts from
-- `getAgentPermissions(agentId)` for an agent that exists. The cascade is here so
-- a long-lived box does not accumulate rows for agents it dismissed years ago.

-- ── WHY `DROP TABLE IF EXISTS` AND NOT `CREATE TABLE IF NOT EXISTS` ──
-- This was written the other way round first, and the ADVERSARIAL rehearsal
-- body killed it (roadmap #16 — the rider exists for exactly this). Planting a
-- LOOSE `grant_rule` — no CHECKs, no NOT NULLs, three duplicate rows, a
-- NULL-everything row, two orphans naming a deleted agent — and applying the
-- original file produced TWO failures in one run:
--
--   1. `CREATE UNIQUE INDEX` died on the planted duplicates
--      (`UNIQUE constraint failed`) and the whole migration aborted, which on a
--      real box aborts the CHAIN and therefore the BOOT (the PHASE-2 `135`
--      incident, verbatim).
--   2. `CREATE TABLE IF NOT EXISTS` had already been a NO-OP against the loose
--      table, so even a successful run would have left a box with **none of the
--      guarantees this migration exists to give it** while `_migrations` claimed
--      it had them. A guard that reports success without existing is the exact
--      disease this overhaul is here to delete.
--
-- Dropping first is safe HERE and would not be safe for a table that held state:
-- every row is a projection of `agents.permissions` carrying the fingerprint it
-- was projected from, so a dropped row costs one re-projection on that agent's
-- next authorize and nothing else. There is no data in this table that is not
-- derivable, by design.
DROP TABLE IF EXISTS grant_rule;

CREATE TABLE grant_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  -- The broker vocabulary, not the manifest's field names: one row says what an
  -- agent may do to a KIND of resource, which is the thing `authorize()` asks.
  effect_kind TEXT NOT NULL CHECK (effect_kind IN (
    'fs_read', 'fs_write', 'fs_delete', 'shell', 'net', 'spawn', 'system_control'
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
  -- This is the anti-drift mechanism: a mismatch means "re-project", so the rows
  -- can never answer a question the manifest has since changed its mind about.
  manifest_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- The read path, exactly: one agent, one kind, deny before allow.
CREATE INDEX grant_rule_lookup
  ON grant_rule (agent_id, effect_kind, mode DESC);

-- A duplicated rule is a defect, not a merge: two identical rows mean the
-- projection ran twice and the second run did not clean up after the first.
-- Making it unrepresentable is cheaper than detecting it.
CREATE UNIQUE INDEX grant_rule_unique
  ON grant_rule (agent_id, effect_kind, mode, pattern, source);
