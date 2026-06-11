-- Migration 062: video generation jobs.
--
-- Video generation is async (1 to 10 min), unlike image/audio which are
-- synchronous. A job is submitted to the provider, returns a provider job
-- id, and a boot-time poller advances it to completion. The row outlives
-- a server restart so an in-flight job survives a crash/redeploy: on boot
-- the poller picks up every row still in 'queued' or 'polling'.
--
-- status lifecycle: queued -> polling -> succeeded | failed | cancelled.
--   queued     submitted to provider, not yet polled
--   polling    provider acknowledged, asset not ready
--   succeeded  asset downloaded + delivered to the agent's chat
--   failed     provider reported failure, or we gave up
--   cancelled  user hit Stop in the dashboard

CREATE TABLE IF NOT EXISTS video_jobs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_job_id TEXT,
  prompt TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  asset_path TEXT,
  duration_seconds REAL,
  cost_usd REAL,
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS video_jobs_status_idx ON video_jobs(status);
CREATE INDEX IF NOT EXISTS video_jobs_agent_idx ON video_jobs(agent_id);
