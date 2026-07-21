-- 119: the owner-affinity promotion cooldown becomes a COLUMN on the
-- conversation row (lanes & lineage P5c), replacing per-convKey engine
-- bookkeeping keys sprayed into the config table. The legacy keys are swept;
-- a promotion shortly after upgrade is acceptable (the cooldown is a
-- politeness bound, not a correctness gate).
ALTER TABLE conversations ADD COLUMN last_affinity_promo_at TEXT;
DELETE FROM config WHERE key LIKE 'owner_affinity_last_promo:%';
