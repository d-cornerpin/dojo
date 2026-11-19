-- REQUIRES-COLUMN: work.next_attempt_at
-- No product code wrote work.next_attempt_at before this step; the column carried legacy values through 901.
UPDATE work SET next_attempt_at = NULL WHERE next_attempt_at IS NOT NULL;
-- Nothing writes rate_limited after this build; an agent left in it would never be woken.
UPDATE agents SET status = 'idle' WHERE status = 'rate_limited';
