-- A helper's job left open under a piece that was called off before a call-off ended the two together ends now, once.
UPDATE work SET state = 'abandoned', hold_kind = NULL, hold_reason = NULL, hold_at = NULL,
       closed_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
 WHERE kind = 'task' AND root_kind <> 'a2a_thread' AND state NOT IN ('done', 'failed', 'abandoned')
   AND EXISTS (SELECT 1 FROM work p WHERE p.root_kind = 'a2a_thread' AND p.state = 'abandoned' AND p.assignee_agent = work.agent_id
                AND p.root_id = work.a2a_thread_id AND work.opened_at <= p.closed_at);
