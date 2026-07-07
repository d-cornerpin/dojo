-- 101 (D-B step 2): give healer_proposals the columns the Healer
-- destructive-approval flow needs, so a single owner-approval object can carry
-- BOTH the model-authored proposals it already holds and the new engine-held
-- variety (a live destructive tool call the gate paused for owner approval).
--
-- All additive; existing rows stay NULL and behave exactly as before. A NULL
-- approval_token marks a plain model-authored proposal; a non-NULL token marks
-- an engine-held call whose approval must write a one-shot destructive_approvals
-- row (destructive-gate.ts consumeApproval) that the Healer's retry consumes.
--
--   urgency             routine | urgent, engine-derived (never the model's
--                       word). Urgent proposals expire on the 60-minute
--                       destructive-gate clock; routine keep the 14-day
--                       healer_proposals lifecycle.
--   surface             vitals | toast | imessage, the delivery lane chosen by
--                       the engine presence selector (steps 4/5 render it; the
--                       proposal row itself is always the Vitals mirror).
--   notified_at         when the owner was first surfaced this proposal.
--   approval_token      one-shot token bound to a HELD destructive call; NULL
--                       for model-authored proposals.
--   approval_signature  the canonical destructive-gate signature of the held
--                       call, so owner approval can mint a consumable approval
--                       the Healer's re-attempt of the SAME call consumes once.
ALTER TABLE healer_proposals ADD COLUMN urgency TEXT;
ALTER TABLE healer_proposals ADD COLUMN surface TEXT;
ALTER TABLE healer_proposals ADD COLUMN notified_at TEXT;
ALTER TABLE healer_proposals ADD COLUMN approval_token TEXT;
ALTER TABLE healer_proposals ADD COLUMN approval_signature TEXT;
