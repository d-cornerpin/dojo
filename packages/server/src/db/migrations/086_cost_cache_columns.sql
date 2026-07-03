-- 086: C28 Part 2, prompt-cache accounting on cost_records.
--
-- Cache token counts were READ from every provider response and thrown away
-- (only logger.info'd), so we could never tell how well the KV cache was
-- working or cost the cache-read (0.1x) / cache-creation (1.25x) tiers. These
-- two columns let recordCost persist what each provider reports.
--
-- NULL vs 0 is a deliberate, load-bearing distinction:
--   NULL = the provider did not report this figure (Ollama always; the char
--          estimate fallback on the OpenAI-compatible path when usage is absent).
--   0    = the provider reported zero (a cold call: no cache read, or a call
--          that wrote nothing to cache).
-- Keep it: a hit-ratio reader must not count a non-reporting provider as a miss.
--
-- Backfill: none. Existing rows predate cache accounting and read back NULL,
-- which is correct (their cache behavior is genuinely unknown).

ALTER TABLE cost_records ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE cost_records ADD COLUMN cache_creation_tokens INTEGER;
