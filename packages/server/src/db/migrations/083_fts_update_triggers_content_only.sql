-- 083: narrow the 081 UPDATE triggers to content changes only.
--
-- 081's messages_au / summaries_au fired on ANY column update. Two problems:
-- (1) conv_key / swept_at are stamped on every turn pickup and boot sweep, so each
--     stamp rewrote the row's full FTS entry (pointless index churn on the hottest
--     write path);
-- (2) for rows whose content was edited BEFORE 081 existed, the FTS index still
--     holds the OLD text, so the trigger's 'delete' command was issued with values
--     that do not match the index (undefined behavior for external-content fts5,
--     leaving phantom index entries).
-- Recreating with AFTER UPDATE OF content fixes (1) outright and shrinks (2) to
-- genuine content edits. A full FTS rebuild ('insert into messages_fts(messages_fts)
-- values(''rebuild'')') purges any already-phantom rows, but it locks the DB for
-- minutes on a large messages table, so it stays a supervised manual operator step.

DROP TRIGGER IF EXISTS messages_au;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

DROP TRIGGER IF EXISTS summaries_au;
CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE OF content ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO summaries_fts(rowid, content) VALUES (new.rowid, new.content);
END;
