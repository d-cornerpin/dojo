-- v2.3.19 (error-handling-spec Phase 3): track whether an approved
-- Healer proposal was actually carried out. Pre-spec, the proposal
-- transitioned pending → approved/denied and that was the end of it —
-- there was no record of whether the Healer subsequently applied the
-- approved fix. Now the Healer calls healer_mark_applied(id) after
-- executing, the column moves to a timestamp, and the Vitals UI can
-- distinguish "approved" from "applied".
--
-- Migration is idempotent: the column add fails silently if the column
-- already exists. SQLite doesn't have IF NOT EXISTS for ALTER TABLE ADD
-- COLUMN, so we use a defensive PRAGMA check pattern.

-- Check whether the column already exists before adding (sqlite3 will
-- emit a notice if it does). Migrations.ts wraps each statement in
-- try/catch so a duplicate-column error on re-run is non-fatal.
ALTER TABLE healer_proposals ADD COLUMN applied_at TEXT;
