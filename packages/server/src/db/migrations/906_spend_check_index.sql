-- The daily-spend check (costs/spend.ts getDailySpend) filters cost_records by created_at alone: this index lets it
-- read the last day instead of every cost ever written.
CREATE INDEX IF NOT EXISTS idx_cost_records_created_at ON cost_records(created_at);
