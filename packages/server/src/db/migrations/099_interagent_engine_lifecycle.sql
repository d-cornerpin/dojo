-- 099: D-A step 4, engine-event delivery lifecycle columns on the inter-agent store.
--
-- Step 4 moves the engine-origin notice/event writers (agent-notice, tracker
-- assignment, scheduler fire, healer-denied, thrash steer, engine-origin A2A)
-- off `messages` and into `inter_agent_messages` so no forgetful downstream
-- filter can leak them into human chat. Some of those rows (tracker/scheduler/
-- healer, conv_key NULL) are PENDING ENGINE EVENTS: getPendingEngineEvent picks
-- them up to drive an engine turn, and they carry the migration-084/082 delivery
-- state machine (claimed=conv_key, disposed=swept_at, retry backoff via
-- delivery_attempts/next_attempt_at).
--
-- For that lifecycle to keep working when the event lives in the store, the store
-- needs the SAME three lifecycle columns `messages` carries (082 swept_at,
-- 084 delivery_attempts + next_attempt_at). The engine-event functions in
-- counterparty.ts read/write them by the identical WHERE (DELIVERABLE_ENGINE_EVENT_WHERE)
-- against whichever table the row lives in (merged read, per-table branched write),
-- so a store engine event expires loudly, retries with backoff, and re-homes across
-- a session reset exactly like a `messages` one.
--
-- Defaults mirror 082/084 exactly: swept_at NULL (not disposed), delivery_attempts
-- 0 (never attempted, eligible now), next_attempt_at NULL (eligible immediately).
-- Any peer-A2A store row (origin_kind NULL) simply carries the same harmless
-- defaults and is never selected by the engine-event WHERE (which filters
-- origin_kind='engine'), so no peer traffic is affected.
--
-- No backfill: 098 copied only PEER A2A into the store (origin_kind NULL), and no
-- engine row is ever double-homed (a writer targets exactly one table), so there is
-- nothing pre-existing to seed. FTS is unaffected (the store has no FTS trigger).

ALTER TABLE inter_agent_messages ADD COLUMN swept_at TEXT;
ALTER TABLE inter_agent_messages ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inter_agent_messages ADD COLUMN next_attempt_at TEXT;
