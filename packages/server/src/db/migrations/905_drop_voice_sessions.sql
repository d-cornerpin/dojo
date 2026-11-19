-- Nothing reads the voice identity record, so its table goes. The two messages columns it stamped stay:
-- dropping a column rewrites the whole messages table.
DROP TABLE IF EXISTS voice_sessions;
