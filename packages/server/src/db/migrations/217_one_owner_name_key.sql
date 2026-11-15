-- 217: the owner's name lives under one key, owner_name. A name saved under the old user_name key (Settings, Profile)
-- is the later edit, so it replaces owner_name; the old key is then deleted. A box with no user_name row changes nothing.
INSERT INTO config (key, value) SELECT 'owner_name', TRIM(value) FROM config WHERE key = 'user_name' AND TRIM(value) != ''
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');
DELETE FROM config WHERE key = 'user_name';
