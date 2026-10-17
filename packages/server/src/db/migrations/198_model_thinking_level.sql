-- 198 (t195, owner rulings 8 and 9): HOW HARD A MODEL THINKS, STORED PER MODEL.
--
-- The Settings model row already carries a Thinking on/off toggle (`thinking_enabled`,
-- migration 023). This adds the level beside it. The default is 'high', which is the provider's
-- own default (DeepSeek's thinking-mode page), so no existing model changes behaviour until the
-- owner picks another level.
--
-- Additive only: one column with a constant default; every existing row reads 'high'. The
-- value is SENT only to a model whose contract lists levels (`agent/model-contract.ts`
-- `thinkingLevels`); for every other model it is stored and never sent.

ALTER TABLE models ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'high';
