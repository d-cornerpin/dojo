-- 201 (v3.5): THE SHADOW LOG — what the rule said, what the model said, what really happened.
--
-- One row per judgment the engine asks both its rule and the decision model (`agent/decide.ts`).
-- `truth` arrives later, from the ledger (`truth_src` names which record), and joins by turn and
-- question. The per-question score (`agent/decision-shadow.ts`) and the rule -> shadow -> model policy
-- (`agent/decision-policy.ts`) are computed from these rows; no threshold is typed anywhere.
--
-- Additive only: a brand-new table and two indexes, nothing read, changed or deleted, so a body of
-- any age applies it in O(1). It starts empty.

CREATE TABLE IF NOT EXISTS decision_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT, purpose TEXT NOT NULL, question TEXT NOT NULL,
  agent_id TEXT, turn_id TEXT, rule_said TEXT NOT NULL, model_said TEXT, truth TEXT, truth_src TEXT,
  created_at INTEGER NOT NULL, truth_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_decision_shadow_q ON decision_shadow(purpose, question, created_at);
CREATE INDEX IF NOT EXISTS idx_decision_shadow_turn ON decision_shadow(turn_id);
