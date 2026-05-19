-- Add a `kind` discriminator to tasks. NULL for regular tasks.
-- 'reminder' for reminder_create-originated tasks, which the scheduler
-- fires with a lighter prompt: "deliver this to the user as a single
-- short chat message" instead of the generic scheduled-task boilerplate.
ALTER TABLE tasks ADD COLUMN kind TEXT;
