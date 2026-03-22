-- ══════════════════════════════════════════
-- Phase 4: Smart Routing + System Services
-- ══════════════════════════════════════════

-- Router Configuration
CREATE TABLE IF NOT EXISTS router_tiers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  score_min REAL,
  score_max REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS router_tier_models (
  tier_id TEXT NOT NULL REFERENCES router_tiers(id),
  model_id TEXT NOT NULL REFERENCES models(id),
  priority INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tier_id, model_id)
);

-- Router Dimension Weights
CREATE TABLE IF NOT EXISTS router_dimensions (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  is_enabled INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Router Decision Log
CREATE TABLE IF NOT EXISTS router_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  input_preview TEXT,
  dimension_scores TEXT NOT NULL,
  raw_score REAL NOT NULL,
  tier_id TEXT NOT NULL,
  selected_model_id TEXT NOT NULL,
  fallback_used INTEGER DEFAULT 0,
  latency_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_router_log_created
  ON router_log(created_at);

-- Cost Tracking
CREATE TABLE IF NOT EXISTS cost_records (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  latency_ms INTEGER,
  request_type TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cost_agent_created
  ON cost_records(agent_id, created_at);

CREATE INDEX IF NOT EXISTS idx_cost_model_created
  ON cost_records(model_id, created_at);

-- Budget Configuration
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  limit_usd REAL NOT NULL,
  period TEXT NOT NULL,
  alert_50_sent INTEGER DEFAULT 0,
  alert_75_sent INTEGER DEFAULT 0,
  alert_90_sent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Seed default router tiers
INSERT OR IGNORE INTO router_tiers VALUES ('heavy', 'Heavy', 'Complex reasoning, architecture, creative work', 0.35, NULL, datetime('now'));
INSERT OR IGNORE INTO router_tiers VALUES ('standard', 'Standard', 'Most coding, analysis, standard tasks', 0.0, 0.35, datetime('now'));
INSERT OR IGNORE INTO router_tiers VALUES ('light', 'Light', 'Simple Q&A, formatting, classification', NULL, 0.0, datetime('now'));
INSERT OR IGNORE INTO router_tiers VALUES ('system', 'System', 'Watchdog, heartbeat, emergency iMessage', NULL, NULL, datetime('now'));

-- Seed default dimensions
INSERT OR IGNORE INTO router_dimensions VALUES ('token_count', 'Token Count', 1.0, 1, datetime('now'));
INSERT OR IGNORE INTO router_dimensions VALUES ('code_presence', 'Code Presence', 1.2, 1, datetime('now'));
INSERT OR IGNORE INTO router_dimensions VALUES ('reasoning_markers', 'Reasoning Markers', 1.5, 1, datetime('now'));
INSERT OR IGNORE INTO router_dimensions VALUES ('technical_terms', 'Technical Terms', 0.8, 1, datetime('now'));
INSERT OR IGNORE INTO router_dimensions VALUES ('creative_markers', 'Creative Markers', 1.3, 1, datetime('now'));
INSERT OR IGNORE INTO router_dimensions VALUES ('simple_indicators', 'Simple Indicators', 1.0, 1, datetime('now'));
INSERT OR IGNORE INTO router_dimensions VALUES ('multi_step', 'Multi-Step Patterns', 1.0, 1, datetime('now'));
INSERT OR IGNORE INTO router_dimensions VALUES ('question_complexity', 'Question Complexity', 0.9, 1, datetime('now'));
INSERT OR IGNORE INTO router_dimensions VALUES ('constraint_count', 'Constraint Count', 0.7, 1, datetime('now'));
INSERT OR IGNORE INTO router_dimensions VALUES ('output_format', 'Output Format', 0.6, 1, datetime('now'));
INSERT OR IGNORE INTO router_dimensions VALUES ('agentic_indicators', 'Agentic Task Indicators', 1.1, 1, datetime('now'));
INSERT OR IGNORE INTO router_dimensions VALUES ('vision_multimodal', 'Vision/Multimodal', 2.0, 1, datetime('now'));

-- Seed default global daily budget ($25)
INSERT OR IGNORE INTO budgets VALUES ('global_daily', 'global', 25.0, 'daily', 0, 0, 0, datetime('now'), datetime('now'));
