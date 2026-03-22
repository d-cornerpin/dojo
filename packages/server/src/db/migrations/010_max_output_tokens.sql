-- Add max_output_tokens column to models table
-- Stores the provider-reported maximum output tokens for each model
ALTER TABLE models ADD COLUMN max_output_tokens INTEGER;
