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
//
// t159 I — AN A2A TURN SERVES ITS ASSIGNED MESSAGE TOO (`servedAssignMessageIds`, a separate answer on
// purpose: `servedOwnerMessageIds` is the owner's words and is what a PARK carries on the job record;
// the assignment is re-shown to the view and carried by nothing). The reply-needed message an A2A turn
// was woken to answer (an ASSIGN from a manager, a QUESTION, a BLOCK) is the only user-role row of its
// thread. Once a fold or the token trim takes it behind the boundary, the tail is all tool rows, the
// integrity pass's leading-role shift empties it, and the zero-messages guard pulled the raw row with no
// label (run 7, S1 variant B: 8 calls in a row, 7 messages in view where there had been 409).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { turnContext } from '../agent/turn-context.js';
import { runCarriesJob, jobCarriedAsks } from '../work/task-freshness.js';
import { jobOrigin } from '../work/job-origin.js';
import { findUnrepliedAssignForAgent } from '../agent/a2a-replies.js';
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
    if (!bag.root && runCarriesJob(agentId)) {
      // t173: and the ask the job's own task came from, for a continuation whose parking turn served no ask
      // (an engine notice about the task parked it): the same message, shown the same way. A continuation that
      // restored its person's conversation (`bag.conversationId`) already carries that ask above.
      const origin = bag.conversationId ? null : jobOrigin(agentId);
      return [...new Set([...jobCarriedAsks(agentId), ...(origin?.kind === 'ask' ? [origin.messageId] : [])])];
    }
    return [];
  } catch {
    return [];
  }
}

/** The reply-needed message a running A2A turn is answering, until it is answered; `[]` otherwise. The same
 *  finder preflight used to make the turn an A2A turn, so the two cannot disagree about which message it is. */
export function servedAssignMessageIds(agentId: string): string[] {
  try {
    const bag = turnContext(agentId);
    if (bag?.kind !== 'a2a') return [];
    // t173: a job's continuation serves the request its job started from, replied to or not (the job is
    // still running): its root is that thread, and it is found from the job's task (`work/job-origin.ts`).
    if (bag.root?.kind === 'a2a') {
      const origin = jobOrigin(agentId);
      if (origin?.kind === 'a2a' && origin.threadId === bag.root.id && origin.messageId) return [origin.messageId];
    }
    const assign = findUnrepliedAssignForAgent(agentId);
    return assign ? [assign.messageId] : [];
  } catch {
    return [];
  }
}

/** The served rows that are NOT among `inView` (compared by id), as stored rows, oldest first. */
export function servedRowsOutOfView(agentId: string, inView: readonly { id: string }[]): Message[] {
  const ids = [...servedOwnerMessageIds(agentId), ...servedAssignMessageIds(agentId)];
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
