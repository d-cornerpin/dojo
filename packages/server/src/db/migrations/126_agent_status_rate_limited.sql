-- 126: widen agents.status so 'rate_limited' is a legal value.
--
-- WHY. The three-strike rate-limit manager (agent/rate-limit-retry.ts) is
-- supposed to mark an agent 'rate_limited' on strike 3 and broadcast it, so the
-- dashboard says WHY the agent went quiet instead of showing it idle. The
-- day-0 CHECK on agents.status never listed 'rate_limited', so that UPDATE has
-- always thrown "CHECK constraint failed" — and the throw landed in a bare
-- `catch { /* best effort */ }` that also owned the broadcast. The alert has
-- therefore never fired once, and the two consumers that read the state
-- (healer/diagnostic.ts:137,184 and healer/auto-fix.ts:283) have never seen a
-- row. This migration is the durable half of the fix; the swallow is split in
-- the same commit.
--
-- SQLite cannot ALTER a CHECK constraint, so this is the repo's established
-- table-rebuild pattern (migrations 005 and 103): create, copy, drop, rename.
-- It is a WIDENING only — every value that was legal before is still legal, so
-- no existing row can fail the new constraint and no data mapping is required.
--
-- FOREIGN KEYS. The runner (db/migrations.ts) sets `PRAGMA foreign_keys = OFF`
-- for the whole chain, OUTSIDE the per-migration transactions, because a
-- foreign_keys pragma is a no-op while a transaction is open. This file must
-- therefore NOT carry its own pragma (the runner's contract explicitly lists a
-- foreign_keys pragma as a statement no migration may run). With FK enforcement
-- off, `DROP TABLE agents` drops the table without firing the ON DELETE CASCADE
-- edges that messages / inter_agent_messages / audit_log hold against it.
-- Rehearsed counterfactual (2026-07-27, on a copy of the live dev DB): with
-- foreign_keys ON the DROP raises "FOREIGN KEY constraint failed" and the
-- migration's own transaction rolls back — the failure mode is loud and atomic,
-- never a silent cascade.
--
-- The self-reference on parent_agent is written as `REFERENCES agents(id)`, NOT
-- `REFERENCES agents_new(id)`: ALTER TABLE ... RENAME rewrites references to the
-- OLD name and leaves references to `agents` alone, so this is the spelling that
-- ends up self-consistent. (Rehearsed: the agents_new spelling survives the
-- rename verbatim and leaves a dangling parent table.)
--
-- IDEMPOTENCE. The leading DROP IF EXISTS mirrors 103: the runner already
-- applies+records each file in one transaction, so a partial apply cannot
-- commit, but the guard makes a re-run harmless in any case. Re-running the
-- whole file against an already-widened table is also a no-op in effect.

DROP TABLE IF EXISTS agents_new;

CREATE TABLE agents_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model_id TEXT,
  system_prompt_path TEXT,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK(status IN ('idle', 'working', 'paused', 'error', 'terminated', 'rate_limited')),
  config TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  parent_agent TEXT REFERENCES agents(id),
  spawn_depth INTEGER DEFAULT 0,
  agent_type TEXT DEFAULT 'standard',
  max_runtime INTEGER,
  timeout_at TEXT,
  permissions TEXT DEFAULT '{}',
  tools_policy TEXT DEFAULT '{}',
  task_id TEXT,
  classification TEXT NOT NULL DEFAULT 'apprentice',
  group_id TEXT REFERENCES agent_groups(id),
  equipped_techniques TEXT DEFAULT '[]',
  session_started_at TEXT DEFAULT NULL,
  always_loaded_tools TEXT DEFAULT NULL,
  last_error TEXT,
  last_error_at TEXT,
  recovery_attempts INTEGER DEFAULT 0,
  dreamer_ignore INTEGER DEFAULT 0,
  charter TEXT DEFAULT NULL,
  timeout_decision_pending INTEGER DEFAULT 0,
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL
);

-- Columns are listed explicitly rather than `SELECT *` so a missing column
-- fails loudly here instead of silently shifting values one place left.
INSERT INTO agents_new (
  id, name, model_id, system_prompt_path, status, config, created_by, created_at, updated_at,
  parent_agent, spawn_depth, agent_type, max_runtime, timeout_at, permissions, tools_policy,
  task_id, classification, group_id, equipped_techniques, session_started_at, always_loaded_tools,
  last_error, last_error_at, recovery_attempts, dreamer_ignore, charter, timeout_decision_pending
)
SELECT
  id, name, model_id, system_prompt_path, status, config, created_by, created_at, updated_at,
  parent_agent, spawn_depth, agent_type, max_runtime, timeout_at, permissions, tools_policy,
  task_id, classification, group_id, equipped_techniques, session_started_at, always_loaded_tools,
  last_error, last_error_at, recovery_attempts, dreamer_ignore, charter, timeout_decision_pending
FROM agents;

DROP TABLE agents;

ALTER TABLE agents_new RENAME TO agents;
