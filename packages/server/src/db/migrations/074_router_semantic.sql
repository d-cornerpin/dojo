-- ════════════════════════════════════════
-- Semantic router: decision metadata + on-device learning storage
-- ════════════════════════════════════════

-- Richer router_log: which method decided, its confidence, and the classifier
-- version in force (so a past decision can be reconstructed once the head is
-- self-training and changes over time).
ALTER TABLE router_log ADD COLUMN method TEXT;
ALTER TABLE router_log ADD COLUMN confidence REAL;
ALTER TABLE router_log ADD COLUMN head_version TEXT;

-- Training labels for the on-device head (Phase 3). One row per harvested
-- (embedding -> correct tier) example. Embedding is stored as a raw Float32
-- blob, same convention as the memory engine's embeddings table.
CREATE TABLE IF NOT EXISTS router_labels (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  embedding BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  label TEXT NOT NULL CHECK(label IN ('light', 'standard', 'heavy')),
  source TEXT NOT NULL,            -- 'implicit_under' | 'probe_down' | 'correction'
  weight REAL NOT NULL DEFAULT 1.0,
  query_preview TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_router_labels_created ON router_labels(created_at);

-- Trained heads. Multinomial logistic-regression weights stored as a Float32
-- blob. At most one row is active at a time; the classifier prefers the active
-- head over the shipped exemplar centroids.
CREATE TABLE IF NOT EXISTS router_head (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  weights BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  classes TEXT NOT NULL,           -- JSON array, e.g. ["light","standard","heavy"]
  trained_at TEXT NOT NULL DEFAULT (datetime('now')),
  trained_on INTEGER NOT NULL DEFAULT 0,   -- label count used
  eval_score REAL,                 -- held-out accuracy of this head
  is_active INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_router_head_active ON router_head(is_active);
