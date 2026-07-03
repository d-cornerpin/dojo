-- 081: D20, FTS delete/update sync + one-time orphan-embedding cleanup.
--
-- messages_fts and summaries_fts are external-content fts5 tables that had ONLY
-- an AFTER INSERT trigger. So when a message or summary was deleted or edited,
-- its FTS row was left behind (stale content, and a memory_grep hit that resolves
-- to a row that no longer exists). Separately, message/summary deletes never
-- cleaned up the `embeddings` table, leaving 5,997 orphan message embeddings
-- whose source row is gone, a vector hit on one resolves to "Unknown ID".
--
-- Fix: add the standard external-content delete/update sync triggers so FTS stays
-- correct going forward, and delete the existing orphan message embeddings.
-- (A full FTS 'rebuild' to purge already-orphaned FTS rows is intentionally NOT
-- done here, rebuilding the FTS over the multi-GB messages table would lock boot
-- for minutes; the triggers stop new orphans, and a rebuild is a supervised
-- manual op. Summary embedding orphans were already 0.)

-- messages_fts: external-content delete/update sync
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- summaries_fts: external-content delete/update sync
CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO summaries_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Embeddings cleanup on source deletion (so a future delete can't re-create the
-- orphan backlog). The embeddings table is keyed by (source_type, source_id) with
-- no FK to messages/summaries, so nothing cleaned it up on delete before.
CREATE TRIGGER IF NOT EXISTS messages_embed_ad AFTER DELETE ON messages BEGIN
  DELETE FROM embeddings WHERE source_type = 'message' AND source_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS summaries_embed_ad AFTER DELETE ON summaries BEGIN
  DELETE FROM embeddings WHERE source_type = 'summary' AND source_id = old.id;
END;

-- One-time cleanup: message embeddings whose source message no longer exists.
DELETE FROM embeddings
 WHERE source_type = 'message'
   AND source_id NOT IN (SELECT id FROM messages);
