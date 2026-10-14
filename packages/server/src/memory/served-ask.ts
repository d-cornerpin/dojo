// ════════════════════════════════════════════════════════════════════════════════════════
// t145 round 4 — THE OWNER MESSAGE(S) A RUNNING TURN SERVES.
//
// The "still in force" pin carried the newest long ask into every call. With it gone, the task list
// is the one record of what is current; the one shape it cannot cover is a long turn on an ask that
// never got a task, where a fold in the middle of the turn takes the ask's raw row behind the
// boundary. So the assembler re-emits the SERVED message verbatim at the front of the live tail
// (`memory/assembler.ts` `tailRender`) whenever it is not otherwise in view.
//
// WHICH MESSAGES: structural, from the running turn's OWN recorded facts, no content read. A turn
// is running for this agent when its bag exists. Then:
//   * a turn picked up by an ask (`root.kind === 'ask'`): the trigger message itself, plus the
//     unanswered (`open`) ask rows in the SAME conversation that come AFTER it — the later owner
//     messages merged into this turn. An older ask still `claimed` in that conversation (a job held
//     behind a delegation, say) is NOT this turn's and is never re-shown by it;
//   * a continuation carrying a job (no trigger of its own): exactly the ask(s) the parking turn served,
//     carried on t143's job record (`work/task-freshness.ts`) and still claimed.
// With no running turn, or any other kind of turn (engine, A2A, occurrence), the answer is empty, so
// a finished ask is never re-shown (the #7 defect). Oldest first. Never throws.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { turnContext } from '../agent/turn-context.js';
import { runCarriesJob, jobCarriedAsks } from '../work/task-freshness.js';
import { getMessagesByIds } from './store.js';
import type { Message } from '@dojo/shared';

/** The message ids the running turn serves, oldest first; `[]` when none. */
export function servedOwnerMessageIds(agentId: string): string[] {
  try {
    const bag = turnContext(agentId);
    if (!bag) return [];
    const db = getDb();
    if (bag.root?.kind === 'ask' && bag.root.sourceMessageId) {
      const trigger = bag.root.sourceMessageId;
      const rows = db.prepare(
        `SELECT m.id AS id FROM messages m
          WHERE m.id = @trigger AND m.agent_id = @agentId AND m.role = 'user'
             OR (m.agent_id = @agentId AND m.role = 'user'
                 AND m.conversation_id = (SELECT conversation_id FROM messages WHERE id = @trigger)
                 AND m.seq > (SELECT seq FROM messages WHERE id = @trigger)
                 AND EXISTS (SELECT 1 FROM work w WHERE w.kind = 'ask' AND w.root_id = m.id AND w.state = 'open'))
          ORDER BY m.seq ASC`,
      ).all({ agentId, trigger }) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    }
    // A continuation carrying a job: the ask(s) the PARK recorded on the job's own record (t143's
    // carry, `work/task-freshness.ts`), and only a run launched from that park's wake carries it. Any
    // other trigger-less run (an A2A, the scheduler, an engine event) serves nothing it did not pick up.
    if (!bag.root && runCarriesJob(agentId)) return jobCarriedAsks(agentId);
    return [];
  } catch {
    return [];
  }
}

/** The served rows that are NOT among `inView` (compared by id), as stored rows, oldest first. */
export function servedRowsOutOfView(agentId: string, inView: readonly { id: string }[]): Message[] {
  const ids = servedOwnerMessageIds(agentId);
  if (ids.length === 0) return [];
  const seen = new Set(inView.map((m) => m.id));
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length === 0) return [];
  try {
    return getMessagesByIds(missing).sort((a, b) => (a.rowid ?? 0) - (b.rowid ?? 0));
  } catch {
    return [];
  }
}
