// ════════════════════════════════════════════════════════════════════════════════════════
// t165 — ANOTHER AGENT'S REQUEST IS WORKED IN ITS OWN CONVERSATION, NEVER INSIDE THE OWNER'S.
//
// (Reply tracking itself stays in `a2a-replies.ts`; this module only asks it.)
//
// The owner's ruling, 2026-10-14: "Keep it separate." The measured defect (a release run, scenario
// S3): a peer's QUESTION landed while the agent was busy with the owner, its wake was deferred, and
// the OWNER turn's model found the question through its own recall tool, searched for the answer
// and sent it on the peer's thread — so no turn ever ran for that thread and the owner's chat
// carried work that was not the owner's.
//
// "STILL AWAITING ITS OWN TURN" IS NOT NEW STATE. It is the question the engine already asks at
// every turn end (`runtime.ts`, the A2A re-trigger) and at every turn start (preflight): is there
// an inbound QUESTION/ASSIGN/BLOCK with no recorded reply — `findUnrepliedAssignForAgent`. When
// there is, the runtime queues a dedicated A2A turn for it right after the turn in flight. This
// section asks the SAME function, so "handled on its own turn, right after this one" is true by
// construction of the thing it describes, not by a second opinion about it. It is read from rows
// and the reply table, never from text.
// ════════════════════════════════════════════════════════════════════════════════════════

import { A2A_THREAD_SHORT_LENGTH, a2aThreadTokenMatches } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { findUnrepliedAssignForAgent, type UnrepliedAssign } from './a2a-replies.js';
import { turnContext } from './turn-context.js';

/** The request this agent owes a reply to — the one the runtime will give its own turn. */
export function requestAwaitingItsOwnTurn(agentId: string): UnrepliedAssign | null {
  try { return findUnrepliedAssignForAgent(agentId); } catch { return null; }
}

/**
 * Is the turn in flight the turn that serves `owed`? `true` when it is an A2A turn that began AFTER
 * the request landed — the request is then what it was picked up for (preflight takes the newest
 * unreplied request, and `owed` is the newest there is, so nothing sits between them); `false` for
 * any other turn (an owner turn, an engine turn, an A2A turn the request landed in the middle of);
 * `null` when it cannot be said — no turn open (a call outside a turn) or a turn this process did
 * not pick up (no pickup mark). A caller that REFUSES must read `null` as "do not refuse".
 *
 * The decision is the request's place in the SEQUENCE against the turn's pickup mark, never a
 * comparison of thread names: two named threads can share their first eight characters, and
 * a turn must not be taken for another thread's owner on a prefix.
 */
export function liveTurnServes(agentId: string, owed: UnrepliedAssign): boolean | null {
  const bag = turnContext(agentId);
  if (!bag) return null;
  if (bag.kind !== 'a2a') return false;
  if (bag.pickupSeq == null) return null;
  const row = getDb().prepare('SELECT seq FROM messages WHERE id = ?').get(owed.messageId) as { seq: number } | undefined;
  if (!row) return null;
  return row.seq <= bag.pickupSeq;
}

/**
 * The STRUCTURAL BACKSTOP behind the label. A `send_to_agent` carrying `thread_id` continues that
 * thread, and any send on it records the awaiting request as replied — which is exactly what
 * would cancel its own turn. Returns the awaiting request when `threadId` names ITS thread and the
 * turn in flight is not the one serving it; null when the send may go (a new thread, any other
 * thread, the request's own turn, a call outside any turn).
 */
export function requestOnThreadForAnotherTurn(agentId: string, threadId: string | undefined): { threadShort: string; refusal: string } | null {
  const token = threadId?.trim();
  if (!token) return null;
  const owed = requestAwaitingItsOwnTurn(agentId);
  if (!owed) return null;
  const names = owed.threadId != null
    ? token === owed.threadId || a2aThreadTokenMatches(token, owed.threadId)
    : token === owed.threadShort || token.slice(0, A2A_THREAD_SHORT_LENGTH) === owed.threadShort;
  if (!names || liveTurnServes(agentId, owed) !== false) return null;
  return {
    threadShort: owed.threadShort,
    refusal: `Not sent: the ${owed.intent} from "${owed.fromName}" on thread ${owed.threadShort} is handled on its own turn, right after this one, and answered there. `
      + `It is not part of this conversation, so do not work on it or answer it here. Nothing was sent to "${owed.fromName}" and the request stays waiting for its turn.`,
  };
}
