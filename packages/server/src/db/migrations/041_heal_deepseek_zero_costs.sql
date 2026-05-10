-- v2.3.15: Heal DeepSeek model rows that had zero input/output costs from
-- earlier seed runs. The seed function in config.ts only INSERTs new rows
-- and never updates existing ones, so any DeepSeek model row created
-- before pricing was wired in stuck at 0/0 forever — making cost
-- tracking on the Costs page report $0.00 for every DeepSeek call.
--
-- Only updates rows where BOTH costs are currently zero. If a user
-- manually set non-zero prices, those are preserved.

UPDATE models
SET input_cost_per_m = 0.14,
    output_cost_per_m = 0.28,
    updated_at = datetime('now')
WHERE api_model_id = 'deepseek-v4-flash'
  AND COALESCE(input_cost_per_m, 0) = 0
  AND COALESCE(output_cost_per_m, 0) = 0;

UPDATE models
SET input_cost_per_m = 0.435,
    output_cost_per_m = 0.87,
    updated_at = datetime('now')
WHERE api_model_id = 'deepseek-v4-pro'
  AND COALESCE(input_cost_per_m, 0) = 0
  AND COALESCE(output_cost_per_m, 0) = 0;
