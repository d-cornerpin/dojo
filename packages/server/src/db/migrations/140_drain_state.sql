-- 140_drain_state.sql — PHASE-2 T10, RULING 5: the drain counters get a restart-safe home.
--
-- ── WHAT THIS IS FOR ──
--
-- Two drains in `agent/runtime.ts` kept their bound in a module-scope `Map`:
--
--   wakeDrainHead : agentId -> { head: 'w:<rowid>' | 'e:<rowid>', stuck }
--   drainHead     : agentId -> { rowid: <oldest waiting>,          stuck }
--
-- Each counts CONSECUTIVE drain passes that saw the SAME head without advancing it, and
-- stands the self-wake down at its bound (2 and MAX_DRAIN_STUCK). A Map dies with the
-- process, so **a crash loop reset the storm protection to zero on every boot** — which is
-- the 2026-07-23 storm hazard wearing a different hat, on exactly the machine (a lived-in
-- box with a deep backlog) where it did the damage.
--
-- ── WHY THIS TABLE AND NOT A COLUMN (T9 measured every alternative; none survived) ──
--
--   * `work.attempts`              — REFUSED by `single-writer-conformance.test.ts` PART C,
--                                    which measured it as the recurrence fire count (one
--                                    writer, four readers, all aliasing it to `run_count`).
--                                    A retry count in that integer ends the first retried
--                                    `after_count` schedule early.
--   * `messages.delivery_attempts` — REFUSED on its own measurement: the engine event's
--                                    failed-DELIVERY counter, five of which expire the event
--                                    loudly. A head that failed to advance twice is not a
--                                    delivery that failed twice.
--   * a derivation from `turns`    — REFUSED BY THE BATTERY. T9 built
--                                    `endedTurnsSince(headArrival) - 1` and
--                                    `multi-agent-project` went 0/3 (run `bms651uo8lh`, retry
--                                    lane used, "NOT a flake"): a deliverable arrives
--                                    mid-orchestration, the primary runs several legitimate
--                                    turns serving the human first, and the derivation counts
--                                    turns during which the drain was NOT LOOKING at the head.
--
-- T9 named the two shapes that would work. This is the second one, with the rename it asked
-- for: `healer_state`'s `(scope, key, at_ms)` is the right SHAPE and the wrong NAME, and
-- borrowing it would have put engine drain state in a table named for the healer.
--
-- ── WHAT IS DELIBERATELY NOT HERE: A STALENESS BOUND ──
--
-- Carrying the count across a restart is not an approximation, it is exactly what the Map
-- would have done had the process lived: `stuck` counts CONSECUTIVE passes, and while the
-- process was down there were no passes. So no "expire the ladder after N minutes" rule is
-- written, and none is invented (#14) — the ladders are already self-limiting from both
-- ends, measured at their own sites:
--   * a NEW head resets `stuck` to 0, which is the Map's semantics preserved exactly;
--   * the wake drain's head comes from `findUnservedTerminalWake`, which is bounded to 45
--     minutes at the finder, so a stale head stops being the head and the row is deleted;
--   * the human drain's head advances on serve, and at its bound the poisoned conversation
--     is quarantined and the NEXT one becomes the head (D9).
--
-- ── SHAPE NOTES ──
--
-- `ON DELETE CASCADE` here is the opposite of `work.agent_id`'s deliberate no-FK (T0 D1: a
-- terminated agent's WORK must outlive its agent). Drain state is not work — it is one
-- engine loop's bookkeeping about an agent that still exists. When the agent is gone there is
-- nothing left to drain, so the row goes with it.

CREATE TABLE IF NOT EXISTS drain_state (
  -- Which agent's drain this ladder belongs to.
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- WHICH drain. Named rather than free text so a third drain has to declare itself here
  -- instead of quietly sharing another one's counter — the two-mechanism shape this phase
  -- exists to delete.
  drain      TEXT NOT NULL CHECK (drain IN ('unserved_wake', 'human_conversation')),
  -- The head token this ladder is counting against. It is part of the ROW, not a separate
  -- fact: a different head means a different ladder, which is how "consecutive" is enforced.
  -- Opaque on purpose — 'w:<rowid>' / 'e:<rowid>' for the wake drain, the oldest waiting
  -- rowid for the human drain — because the two drains identify their heads differently and
  -- a shared parsed shape would be a third mechanism.
  head       TEXT NOT NULL,
  -- Consecutive passes that saw this head and did not advance it. Zero on the first sighting.
  stuck      INTEGER NOT NULL DEFAULT 0 CHECK (stuck >= 0),
  -- Recorded for diagnosis, and so a future prune has something honest to sort by. It is NOT
  -- read by any bound: see "no staleness bound" above.
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, drain)
);
