// v3.5 DONE IS MEASURED (t250 fix round 4, orchestrator ruling) — WHEN A QUOTE IS THE OWNER'S.
//
// `work_validate(action="apply_user_verdict")` is called by a MODEL with a `user_quote` the model
// supplies. The owner's exemption (he can always close his own task) applies to a VERIFIED owner
// act only: the quote must be found verbatim in a stored message the owner wrote, sent since the
// verdict was asked of him. A message counts as his when it came in through an ingest door (it has
// a channel; the platform's own second-person rows have none) and its stamped origin says the
// owner (`deriveOrigin`, the one "who is this from" answer). Otherwise the act is the model's.
import { deriveOrigin, legacyOriginInputs } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { WORK_EVENT } from '../work/tracker-view.js';

interface Row {
  content: string; lane: string; channel: string | null; source_agent_id: string | null;
  a2a_thread_id: string | null; a2a_intent: string | null; a2a_requires_response: number | null;
  inbound_meta: string | null; origin_intent: string | null;
}

/** Did the owner himself write `quote`, since the verdict on `taskId` was requested? */
export function ownerSaidSinceVerdictAsked(taskId: string, quote: string): boolean {
  const q = quote.trim();
  if (!q) return false;
  const asked = getDb().prepare(
    'SELECT MAX(created_at) AS at FROM work_events WHERE work_id = ? AND kind = ?',
  ).get(taskId, WORK_EVENT.userVerdictRequested) as { at: number | null };
  if (asked.at === null) return false;
  const rows = getDb().prepare(
    `SELECT content, lane, channel, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response,
            inbound_meta, origin_intent
       FROM messages
      WHERE role = 'user' AND lane = 'owner' AND channel IS NOT NULL AND source_agent_id IS NULL
        AND sent_at >= ? AND instr(content, ?) > 0`,
  ).all(Math.floor(asked.at / 1000) * 1000, q) as Row[];   // floored to the second: `sent_at`'s default is second-resolution
  return rows.some((m) => {
    const o = deriveOrigin({
      role: 'user', content: m.content, ...legacyOriginInputs(m.lane, m.channel),
      sourceAgentId: m.source_agent_id, a2aThreadId: m.a2a_thread_id, a2aIntent: m.a2a_intent,
      a2aRequiresResponse: m.a2a_requires_response, inboundMeta: m.inbound_meta, originIntent: m.origin_intent,
    });
    return o.kind === 'user' && o.relation === 'owner';
  });
}
