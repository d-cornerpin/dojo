-- ══════════════════════════════════════════════════════════════════════════════════════
-- 149_cost_records_estimate.sql — PHASE-3 T2 Step 3: the estimate stands beside the truth.
--
-- Research 06 requirement A2's other half. `cost_records` already carries what the PROVIDER
-- charged for input on every call. It has never carried what the platform BELIEVED that
-- input would cost, so the estimator's systematic error has only ever been a comment —
-- research 06 wrote "the 33% systematic error" with no way for anyone to re-derive it, and
-- PHASE-3 T2 had to reconstruct the number from 1,409 receipt files joined to this table by
-- timestamp in order to choose a divisor at all. That reconstruction is not repeatable
-- inside the product, and it should not have to be.
--
-- Two columns, both NULLABLE and both written by the transports at the moment they send:
--
--   estimated_input_tokens     what `memory/budget.ts`'s estimator said the input would cost
--   estimator_chars_per_token  the divisor that produced it
--
-- The divisor is recorded WITH the estimate on purpose. A future task that re-derives the
-- divisor must not silently re-interpret history: a row measured at 4 chars/token and a row
-- measured at 3.5 are different measurements, and a trend line that mixes them without
-- saying so is the "verdict produced by summarising" class roadmap #14 exists to refuse.
--
-- NULL means "this call did not record an estimate" and never "the estimate was zero" —
-- the Ollama and agent-SDK paths do not compute one, and a reader must not count them as
-- perfect predictions (#15: an absence is a question, not an answer).
--
-- NOTHING IS BACKFILLED. The 8,005 rows already here were written by transports that never
-- computed an estimate; inventing one now from their stored bytes would manufacture exactly
-- the agreement this pair of columns exists to measure.
-- ══════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE cost_records ADD COLUMN estimated_input_tokens INTEGER;
ALTER TABLE cost_records ADD COLUMN estimator_chars_per_token REAL;

CREATE INDEX IF NOT EXISTS idx_cost_records_estimate
  ON cost_records(created_at) WHERE estimated_input_tokens IS NOT NULL;
