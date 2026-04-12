-- Per-model override for Ollama's num_ctx (the KV-cache window passed on
-- each /api/chat call). NULL means "don't pass num_ctx" — Ollama falls back
-- to the model's Modelfile default, which is the current behavior for
-- every Ollama model on existing installations. Setting an explicit value
-- both tells the runtime to send `options: { num_ctx: N }` and makes the
-- effective context visible to the user in Settings → Models.
--
-- Only meaningful for provider type 'ollama'. Other providers ignore it.
ALTER TABLE models ADD COLUMN num_ctx_override INTEGER DEFAULT NULL;
