-- 109 (Spawn contract: creator-owned timeouts + mandatory project squads)
--
-- P3 (timeout ownership). The apprentice timeout stops being a silent kill and
-- becomes a decision owned by the CREATOR. When a spawned agent reaches its
-- timeout the engine no longer terminates it; it posts an awareness notice to the
-- creating agent and waits for spawn_timeout_decision(extend|terminate). The
-- sub-agent keeps running until an authorized hand decides.
--
-- timeout_decision_pending tracks that wait as a deterministic tri-state so the
-- flow is reboot-safe (the in-memory timers are lost on restart; the boot re-arm
-- and the 30s sweep read this column, never double-notify):
--   0 = no decision pending (not yet timed out, or extended/resolved)
--   1 = decision notice posted to the creator, awaiting its decision
--   2 = also escalated once to the primary (undecided ladder), awaiting; never
--       notified again (the sub-agent still runs, never auto-killed)
-- Backfill: none. Existing rows default to 0, the honest "no pending decision".
ALTER TABLE agents ADD COLUMN timeout_decision_pending INTEGER DEFAULT 0;

-- P4 (mandatory project squads). A project owns the squad its spawned agents
-- land in. When an agent spawns for a project, the engine auto-creates (or
-- reuses) a squad named after the project title and stamps its id here; every
-- later spawn linked to the same project auto-joins that squad. NULL = no squad
-- stamped yet. (agent_groups.created_by already records the squad's creator, so
-- no groups column is added here.)
ALTER TABLE projects ADD COLUMN group_id TEXT;
