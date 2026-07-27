-- ════════════════════════════════════════
-- 125: backfill `setup_completed` on boxes that finished first run before the
--      flag existed  (PHASE-0 T9 — Stable Bridge ledger entry #1)
-- ════════════════════════════════════════
--
-- From T9 on, the `/api/setup/` routes are reachable without a token ONLY while
-- the box has never completed first run. That gate reads this config row. Every
-- install that predates the flag has no row at all, and reading a missing row as
-- "false" means "first run", which means those doors stay open on a
-- fully-configured machine — the exact hole T9 closes.
--
-- So: where the DATABASE itself shows a configured box, say so. The evidence is
-- the same evidence GET /api/setup/status has always used to keep legacy
-- installs out of the wizard — a real provider or a real enabled model, ignoring
-- the two sentinels every fresh database seeds ('__system__' and the 'auto'
-- router model). Nothing is invented here; the row is made to agree with the
-- verdict the product already reached.
--
-- The other half of the evidence — a dashboard password hash — lives in
-- ~/.dojo/secrets.yaml, which SQL cannot read. `isSetupCompleted()` in
-- config/setup-state.ts checks it at runtime, so the gate does not depend on
-- this migration having run, and this migration does not try to guess at a file.
--
-- SAFE ON A LIVED-IN DATABASE (OR5): one conditional INSERT into `config`.
--   * It never UPDATEs or DELETEs anything, so no existing value can be lost --
--     including an explicit 'false' someone set deliberately.
--   * The NOT EXISTS guard makes it idempotent: a second run is a no-op, and it
--     cannot double-insert (`config.key` is the primary key besides).
--   * A genuinely fresh database has only the sentinels, matches nothing, and is
--     left untouched, so first run still happens on a new install.

INSERT INTO config (key, value, created_at, updated_at)
SELECT 'setup_completed', 'true', datetime('now'), datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'setup_completed')
  AND (
    EXISTS (SELECT 1 FROM providers WHERE id != '__system__')
    OR EXISTS (SELECT 1 FROM models WHERE is_enabled = 1 AND id != 'auto')
  );
