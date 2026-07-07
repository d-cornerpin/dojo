-- Healer proposals: record diagnostic provenance so the stale-proposal
-- sweep can match a pending proposal back to the anomaly that produced it.
--
-- Before this, the sweep matched pending proposals on `category` (free
-- text the model supplies) against diagnostic CODES, two disjoint
-- domains, so a still-relevant proposal was auto-resolved on the very
-- next cycle and the owner lost their chance to approve it. We now
-- persist the originating diagnostic code (the agent it concerns already
-- lives in `agent_id`, and the run it came from in `diagnostic_id`), so
-- the sweep keys on a real, stable identifier.
--
-- Existing rows stay NULL. A NULL-provenance proposal is never
-- auto-resolved by issue-matching; it can only be closed by the
-- generous age-cap backstop (see healer-agent.ts sweep).

ALTER TABLE healer_proposals ADD COLUMN diagnostic_code TEXT;
