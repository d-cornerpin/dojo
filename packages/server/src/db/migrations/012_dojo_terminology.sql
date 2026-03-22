-- Rename classification values: permanent → sensei, freelance → ronin, temp → apprentice
UPDATE agents SET classification = 'sensei' WHERE classification = 'permanent';
UPDATE agents SET classification = 'ronin' WHERE classification = 'freelance';
UPDATE agents SET classification = 'apprentice' WHERE classification = 'temp';

-- Rename task status values: pending → on_deck, failed → fallen
UPDATE tasks SET status = 'on_deck' WHERE status = 'pending';
UPDATE tasks SET status = 'fallen' WHERE status = 'failed';

-- Update task_runs status values
UPDATE task_runs SET status = 'on_deck' WHERE status = 'pending';
UPDATE task_runs SET status = 'fallen' WHERE status = 'failed';

-- Rename system group to Masters
UPDATE agent_groups SET name = 'Masters', description = 'The sensei agents. Permanent members of the dojo who cannot be dismissed.' WHERE id = 'system-group';
