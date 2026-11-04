-- 209 (v3.5, field failure 2): WHAT EARLIER 3.5 BUILDS LEFT ON A BOX THAT THIS BUILD MUST NOT READ AS IT WAS.
--
-- Runs before the server binds its port, so the dashboard that reconnects at the update can never read them.
--
-- 1. Cards this build never tells (owner ruling OR-UPKEEP-AUTOMATIC): the manual limit card of preflight.1
--    (`ollama-limit-manual:<n>`), "the limit was raised" (`ollama-limit-set`) and "restart the Ollama the Dojo did not
--    start" (`ollama-restart-needed`). Their told and dismissed records go; an unknown key would otherwise be read back in
--    another card's words (review H4).
-- 2. The decision model's row and `decision_model_id`: preflight.1/.2 registered them for a model they skipped pulling (E1),
--    and that made every judgment dial a model that is not there. The row is disabled and the id removed; the next install
--    registers both again from what Ollama lists, so a box that really has the model gets them back at its first answer
--    (review M5). The writer's row is left as it is: agents may use it.
-- 3. Records of the Dojo's own former `ollama serve` child and of the limit card's value, which nothing reads any more.
--
-- Only rows earlier builds wrote are touched; no owner setting changes.

DELETE FROM healer_state WHERE scope IN ('owner_told', 'owner_dismissed')
  AND (key LIKE 'ollama-limit-manual:%' OR key IN ('ollama-limit-set', 'ollama-restart-needed'));
UPDATE models SET is_enabled = 0, updated_at = datetime('now') WHERE is_enabled = 1 AND capabilities LIKE '%"decision"%';
DELETE FROM config WHERE key IN ('decision_model_id', 'ollama_own_serve', 'ollama_limit_told');
