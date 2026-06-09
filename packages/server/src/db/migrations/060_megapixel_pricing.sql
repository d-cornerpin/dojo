-- v2.10.4 - Allow image-gen models to be priced per megapixel.
--
-- Some image-generation providers (notably several OpenRouter SKUs)
-- charge by output megapixel rather than by token. The existing
-- input_cost_per_m / output_cost_per_m columns are token-only and don't
-- model that, so users were stuck either typing a fictional token price
-- or leaving the model as "Pricing not listed".
--
-- New columns:
--   pricing_unit       'token' (default) or 'megapixel'. Drives which
--                      column the UI reads/writes and what label the
--                      cost line renders.
--   cost_per_megapixel One number in dollars per output megapixel.
--                      Only meaningful when pricing_unit = 'megapixel'.
--
-- Backward-compatible: every existing row defaults to 'token' so all
-- current behavior is preserved.

ALTER TABLE models ADD COLUMN pricing_unit TEXT NOT NULL DEFAULT 'token';
ALTER TABLE models ADD COLUMN cost_per_megapixel REAL;
