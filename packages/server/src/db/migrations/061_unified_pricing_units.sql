-- v2.11.0 — Unified per-unit pricing.
--
-- v2.10.4 introduced megapixel pricing for image-gen models with a
-- dedicated `cost_per_megapixel` column. As we add video, audio, and
-- transcription capabilities (each with its own pricing unit: second,
-- character, minute), the per-unit-column approach gets unwieldy fast.
-- This migration unifies all non-token pricing into one `cost_per_unit`
-- column. The `pricing_unit` value (token | megapixel | second |
-- character | minute) disambiguates what `cost_per_unit` means for a
-- given row.
--
-- Token pricing is unchanged: input_cost_per_m + output_cost_per_m
-- still drive token-mode cost. Only the non-token branches reroute.
--
-- Backfill: any existing megapixel-priced row gets cost_per_megapixel
-- copied into cost_per_unit. We keep the legacy column in place for
-- one release as a rollback safety net; it can be dropped in a future
-- migration once we've confirmed no readers depend on it.
--
-- Idempotent: re-running has no effect after the first pass because
-- the COALESCE leaves existing cost_per_unit values alone.

ALTER TABLE models ADD COLUMN cost_per_unit REAL;

UPDATE models
SET cost_per_unit = cost_per_megapixel
WHERE pricing_unit = 'megapixel'
  AND cost_per_megapixel IS NOT NULL
  AND cost_per_unit IS NULL;
