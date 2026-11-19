-- The old enforcer owed, per agent, only its newest reply-needed request, and only when that one had no reply row.
UPDATE messages SET swept_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
 WHERE role = 'user' AND lane <> 'events' AND a2a_intent IN ('QUESTION', 'ASSIGN', 'BLOCK') AND swept_at IS NULL
   AND created_at >= CAST((julianday('now') - 2440587.5 - 1) * 86400000 AS INTEGER)
   AND seq IS NOT (
     SELECT n.seq FROM messages n
      WHERE n.agent_id = messages.agent_id AND n.role = 'user' AND n.lane <> 'events'
        AND n.a2a_intent IN ('QUESTION', 'ASSIGN', 'BLOCK')
        AND NOT EXISTS (SELECT 1 FROM a2a_replies r WHERE r.assign_message_id = n.id)
        AND n.seq = (SELECT MAX(x.seq) FROM messages x WHERE x.agent_id = n.agent_id AND x.role = 'user'
                       AND x.lane <> 'events' AND x.a2a_intent IN ('QUESTION', 'ASSIGN', 'BLOCK')));
DROP TABLE IF EXISTS a2a_replies;
