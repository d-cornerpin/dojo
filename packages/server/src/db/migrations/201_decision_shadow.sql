-- 201 (v3.5): THE SHADOW LOG — what the rule said, what the model said, what really happened.
--
-- One row per judgment the engine asks both its rule and the decision model (`agent/decide.ts`).
-- `truth` arrives later, from the ledger (`truth_src` names which record), and joins by turn and
-- question. The per-question score (`agent/decision-shadow.ts`) and the rule -> shadow -> model policy
-- (`agent/decision-policy.ts`) are computed from these rows; no threshold is typed anywhere.
--
-- `summary_checks` (B4): every summary the decision model read against its source before it was kept —
-- the outcome and the three probabilities — so the Healer report and the owner's notice speak from
-- measured results.
--
-- Additive only: two brand-new tables and their indexes, nothing read, changed or deleted, so a body
-- of any age applies it in O(1). Both start empty.

CREATE TABLE IF NOT EXISTS decision_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT, purpose TEXT NOT NULL, question TEXT NOT NULL,
  agent_id TEXT, turn_id TEXT, rule_said TEXT NOT NULL, model_said TEXT, truth TEXT, truth_src TEXT,
  created_at INTEGER NOT NULL, truth_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_decision_shadow_q ON decision_shadow(purpose, question, created_at);
CREATE INDEX IF NOT EXISTS idx_decision_shadow_turn ON decision_shadow(turn_id);

CREATE TABLE IF NOT EXISTS summary_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, writer_model_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('ok', 'rewritten_ok', 'failed', 'unavailable')),
  invented REAL, dropped REAL, stated_current REAL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_summary_checks_writer ON summary_checks(writer_model_id, created_at);
