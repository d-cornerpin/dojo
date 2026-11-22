-- A helper's job left open under a piece that was called off before a call-off ended the two together ends now, once:
-- only when every piece of that helper on its thread has ended, none given up by the engine, and no open request holds it as a card.
UPDATE work SET state = 'abandoned', closed_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
 WHERE kind = 'task' AND root_kind <> 'a2a_thread' AND state NOT IN ('done', 'failed', 'abandoned')
   AND EXISTS (SELECT 1 FROM work p WHERE p.root_kind = 'a2a_thread' AND p.state = 'abandoned' AND p.assignee_agent = work.agent_id
                AND p.root_id = work.a2a_thread_id AND work.opened_at <= p.closed_at
                AND NOT EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = p.id AND e.kind = 'transition' AND json_extract(e.payload, '$.by') = 'scheduler'))
   AND NOT EXISTS (SELECT 1 FROM work q WHERE q.root_kind = 'a2a_thread' AND q.root_id = work.a2a_thread_id AND q.assignee_agent = work.agent_id
                    AND q.state IN ('open', 'claimed', 'blocked'))
   AND NOT EXISTS (SELECT 1 FROM work a WHERE a.kind = 'ask' AND a.agent_id = work.requester_id AND a.root_id = work.source_message_id
                    AND a.state NOT IN ('done', 'failed', 'abandoned'));
