-- 157_error_loop_state.sql — PHASE-6 T10 Step 2: the error loop stops forgetting, and the
-- pause it decides leaves evidence.
--
-- ── WHAT THIS IS FOR ──
--
-- `agent/errors.ts` decides that an agent is in an ERROR LOOP — five errors inside two
-- minutes — and pauses it. Until this table both halves of that decision were in a
-- module-scope `Map<string, {timestamp}[]>`:
--
--   * THE COUNT DIED WITH THE PROCESS. An error loop that crashes the server is the one that
--     matters most, and it reset the counter to zero on every boot. A crash loop could
--     therefore never trip the brake designed to stop it — the same class as `drain_state`
--     (migration 140), whose own header says "A Map dies with the process".
--   * THE DECISION LEFT NO EVIDENCE. On tripping, the code paused the agent and then
--     `agentErrors.delete(agentId)` — the five records that justified the pause were
--     destroyed at the moment they became worth reading. The owner saw `status = 'paused'`
--     and a chat notice; nothing durable said WHY, HOW MANY, or OVER WHAT WINDOW.
--
-- ── WHY A TABLE AND NOT AN EXISTING COLUMN OR SINK (each alternative measured) ──
--
--   * `agents.last_error` / `last_error_at`  — ONE error's text and instant. The loop is a
--                                    SET of instants; the last one cannot express five.
--   * `work_events`                — `work_id TEXT NOT NULL REFERENCES work(id)`. An error
--                                    loop belongs to an AGENT and frequently has no work row
--                                    at all (a boot-time model failure has no ask). There is
--                                    no honest parent id to put in that column.
--   * `audit_log`                  — the right SHAPE for the evidence half and the wrong
--                                    OWNER for the state half: it is written through
--                                    `agent/tools/util.ts`, the toolbox, which `agent/errors.ts`
--                                    cannot import (model.ts imports errors.ts, and the
--                                    toolbox reaches model.ts). Splitting the two halves
--                                    across two tables would also mean the evidence and the
--                                    thing it is evidence OF could disagree.
--   * `healer_state (scope,key,at_ms)` — the right shape, the wrong name, and 140 already
--                                    refused it for exactly that reason: engine state does
--                                    not live in a table named for the Healer.
--
-- ── WHAT IS DELIBERATELY NOT HERE: A RETENTION RULE FOR THE EVIDENCE ──
--
-- `kind='error'` rows are working state and are pruned by the writer on every call — outside
-- the two-minute window, or cleared wholesale when a loop trips (the `Map`'s semantics,
-- preserved exactly). `kind='paused'` rows are EVIDENCE and are kept: one row per error-loop
-- pause, which is an incident, not traffic. No "expire after N days" rule is written and none
-- is invented (#14) — a number nobody derived is how evidence quietly stops existing, and the
-- growth rate is one row per incident against an `audit_log` that already holds 20,528.
--
-- ── SHAPE NOTES ──
--
-- `ON DELETE CASCADE`, following 140 and for the same reason: this is one engine loop's
-- bookkeeping about an agent that still exists. When the agent is gone there is no loop left
-- to brake and no pause left to explain. (It is deliberately the opposite of `work.agent_id`,
-- which has no FK because a terminated agent's WORK must outlive it — T0 D1.)

CREATE TABLE IF NOT EXISTS error_loop_state (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Whose loop. CASCADE: see the shape note above.
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- 'error'  — one recorded failure inside the sliding window. Pruned; never read by a person.
  -- 'paused' — the DECISION. One row per trip, retained, and the only thing here that is
  --            evidence. Named rather than free text so a third kind has to declare itself
  --            instead of quietly sharing another one's meaning.
  kind     TEXT NOT NULL CHECK (kind IN ('error', 'paused')),
  -- Epoch ms. The window is computed against this and nothing else, so no clock format can
  -- disagree with another (the `datetime('now')` / epoch-ms split has cost this tree before).
  at_ms    INTEGER NOT NULL,
  -- NULL on an 'error' row. On a 'paused' row: the JSON the decision was made on —
  -- {"errorCount":N,"windowMs":M,"firstErrorAtMs":T}. It is the answer to "why was my agent
  -- paused", which is the question the old code deleted before anyone could ask it.
  detail   TEXT
);

-- The writer's only two access paths: prune/count a window for one agent, and read that
-- agent's pause history. Both are (agent_id, kind, at_ms).
CREATE INDEX IF NOT EXISTS idx_error_loop_state_agent
  ON error_loop_state(agent_id, kind, at_ms);
