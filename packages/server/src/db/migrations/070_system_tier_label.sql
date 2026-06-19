-- The 'system' router tier shipped labeled "Watchdog, heartbeat, emergency
-- iMessage", but nothing ever consumed it — heartbeat is a status tick and
-- emergency iMessage is fixed text. Two real consumers now exist: the
-- multi-step task classifier (any provider), and the watchdog, which uses the
-- model for smarter alert text ONLY when it's a local Ollama model (best-
-- effort, with a hard fallback to fixed text). Make the label honest. Heartbeat
-- is intentionally left out — there's nothing for a model to do there.
UPDATE router_tiers SET description = 'Classifier, watchdog alerts (local)' WHERE id = 'system';

-- The System tier is local-only (enforced in the UI + the API). Purge any
-- non-local model that might already be assigned, so the rule holds for
-- existing installs, not just new assignments.
DELETE FROM router_tier_models
WHERE tier_id = 'system'
  AND model_id IN (
    SELECT m.id FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE p.type <> 'ollama'
  );
