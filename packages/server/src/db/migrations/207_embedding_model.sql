-- 207 (v3.5, owner ruling on switching the embedding model): EVERY STORED VECTOR NAMES THE MODEL
-- THAT MADE IT.
--
-- Until now a vector carried only its width (`embeddings.dimensions`; `vault_entries.embedding`
-- carried not even that), so after the embedding model was switched, old vectors could not be told
-- from new ones: a search compared a new model's query against another model's vectors whenever the
-- two happened to be the same width, and silently scored mismatched widths as zero.
--
-- `embedding_model` is "<provider>:<model>", the same label the code computes from the saved
-- embedding settings. Every vector already stored was made by the model configured now (the only
-- one this box has known), so it is stamped with that label here; a box that never saved embedding
-- settings gets the defaults the code uses. NULL means "unknown" and is never searched.
--
-- Additive only: two nullable columns and one UPDATE of the new column; no existing value changes.

ALTER TABLE embeddings ADD COLUMN embedding_model TEXT;
ALTER TABLE vault_entries ADD COLUMN embedding_model TEXT;

UPDATE embeddings SET embedding_model =
  COALESCE((SELECT json_extract(value, '$.provider') FROM config WHERE key = 'embedding_config' AND json_valid(value)), 'ollama')
  || ':' ||
  COALESCE((SELECT json_extract(value, '$.model') FROM config WHERE key = 'embedding_config' AND json_valid(value)), 'nomic-embed-text')
WHERE embedding_model IS NULL;

UPDATE vault_entries SET embedding_model =
  COALESCE((SELECT json_extract(value, '$.provider') FROM config WHERE key = 'embedding_config' AND json_valid(value)), 'ollama')
  || ':' ||
  COALESCE((SELECT json_extract(value, '$.model') FROM config WHERE key = 'embedding_config' AND json_valid(value)), 'nomic-embed-text')
WHERE embedding IS NOT NULL AND embedding_model IS NULL;
