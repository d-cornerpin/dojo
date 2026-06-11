-- Migration 063: generic media generation jobs (image / audio / music).
--
-- Video has its own async table (video_jobs, migration 062) because it is
-- a 3-legged poll-the-provider flow. Image, audio, and music are
-- "run-once-then-deliver": the request returns the finished asset in a
-- single call, but we still model them as background jobs so the dashboard
-- can show the same spinning-icon + popup indicator video uses, and so a
-- disobedient model can't retry-storm (the tool fires the job and ends the
-- turn; the worker delivers the asset as a synthetic message).
--
-- status lifecycle: queued -> running -> succeeded | failed | cancelled.
--   queued     row written, worker not started yet
--   running    worker is generating the asset
--   succeeded  asset generated + delivered to the agent's chat
--   failed     generation failed, error posted to chat
--   cancelled  user hit Stop in the dashboard

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- 'image' | 'audio' | 'music'
  agent_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  asset_path TEXT,
  asset_mime TEXT,
  duration_seconds REAL,
  cost_usd REAL,
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS generation_jobs_status_idx ON generation_jobs(status);
CREATE INDEX IF NOT EXISTS generation_jobs_agent_idx ON generation_jobs(agent_id);
CREATE INDEX IF NOT EXISTS generation_jobs_kind_idx ON generation_jobs(kind);
