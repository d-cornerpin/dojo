-- 187 (t140): THE CONTINUITY BRIEF'S STORED KEYS ARE REMOVED FROM EVERY AGENT, ONCE.
--
-- ── WHAT WENT AWAY ──
-- Before every non-routine compaction, `memory/compaction.ts` wrote a long model-generated
-- "continuity brief" into `agents.config` under three keys:
--   * `continuityBrief`                — the brief text itself (often thousands of characters);
--   * `continuityBriefAt`              — when it was written (read by the 24-hour
--                                        "Recent Memory Compaction" system section);
--   * `continuityBriefValidUntilTurn`  — the turn after which `lane.continuity` stopped
--                                        injecting it.
-- t140 deletes the writer and the lane (owner ruling OR-V333-SET (1) and OR-TRACKER-1: the task
-- list is the only record of what is current; the brief asked for the user's last instructions
-- verbatim from undated rows and re-presented finished work as live). Nothing writes these keys
-- any more. This file removes the copies already sitting on every upgraded box, so no reader
-- that survives anywhere can find a stale one, and so the system section keyed on
-- `continuityBriefAt` can never render again.
--
-- ── WHAT IT TOUCHES, PRECISELY ──
--   * an agent whose `config` is valid JSON carrying ANY of the three keys (at any value,
--     JSON null included)                       -> those three keys removed, nothing else
--   * every other key in that `config`          -> byte-for-byte UNTOUCHED (`scratchpad`,
--                                                  `toolResultsStubbedBeforeTurn`, …)
--   * a `config` that is NULL, empty or not valid JSON
--                                                -> UNTOUCHED. `json_remove` RAISES on malformed
--                                                   JSON, and a raised error here would fail the
--                                                   whole migration chain and the boot with it, so
--                                                   `json_valid` refuses such rows (inside a CASE,
--                                                   see below) before either JSON function sees
--                                                   them.
--   * valid JSON that is not an object (an array, a scalar)
--                                                -> UNTOUCHED: no key path resolves in it, so the
--                                                   key predicates are already false.
--   * every other table                         -> UNTOUCHED
-- NOTHING IS DELETED except the three keys. The conversation the brief summarised is still in
-- `messages`, the vault archive and the summaries.
--
-- ── IDEMPOTENT BY ITS PREDICATE ──
-- A second run finds no row carrying any of the keys and touches zero rows; it does not lean on
-- the `_migrations` marker to be safe.
--
-- ── REHEARSED ──
-- `db/__tests__/migration-187-continuity-brief-keys.test.ts`: a fresh body, a lived-in body, an
-- ADVERSARIAL body (NULL / empty / malformed / array / scalar configs, keys at JSON null, a key
-- nested one level down that must survive, neighbours that must survive), a re-run, and a
-- `VACUUM INTO` copy of a file body — with the rows each branch touches counted.

-- The guard is a CASE, not an AND: SQLite does not promise to evaluate the terms of a WHERE in
-- the order they are written, and `json_type` raises on malformed JSON exactly as `json_remove`
-- does. A CASE is evaluated in order, so a row `json_valid` rejects never reaches either.
UPDATE agents
   SET config = json_remove(config, '$.continuityBrief', '$.continuityBriefAt', '$.continuityBriefValidUntilTurn')
 WHERE CASE
         WHEN config IS NULL OR NOT json_valid(config) THEN 0
         ELSE (json_type(config, '$.continuityBrief') IS NOT NULL
            OR json_type(config, '$.continuityBriefAt') IS NOT NULL
            OR json_type(config, '$.continuityBriefValidUntilTurn') IS NOT NULL)
       END;
