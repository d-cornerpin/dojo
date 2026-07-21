-- 118: the Healer approval arm joins the exact-call contract (P7b).
-- healer_proposals carries the FULL argument JSON of the held call, so the
-- approval minted on owner approval is exact-call like every other grant.
ALTER TABLE healer_proposals ADD COLUMN approval_args_json TEXT;
