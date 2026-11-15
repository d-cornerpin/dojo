-- 215: the Imaginer agent (retired by 059) ends `terminated` on any box that still has it live, and the four
-- settings only its removed code read are deleted. By-equality matches only; a box with no such row changes nothing.
UPDATE agents SET status = 'terminated', updated_at = datetime('now')
WHERE (id = 'imaginer' OR id IN (SELECT value FROM config WHERE key = 'imaginer_agent_id')) AND status != 'terminated';
DELETE FROM config WHERE key IN ('imaginer_agent_id', 'imaginer_agent_name', 'imaginer_brain_model', 'imaginer_image_model');
