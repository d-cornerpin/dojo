-- What a turn served reads only the agent's rows open during the turn or closed since it began.
CREATE INDEX IF NOT EXISTS ix_work_agent_closed ON work(agent_id, closed_at);
