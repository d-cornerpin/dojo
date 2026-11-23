// A peer's request is worked in its own conversation, never the owner's turn; this module adds no state.

import { a2aThreadTokenMatches } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { agentRequests, type AgentRequest } from './v2/owed.js';
import { turnContext } from './turn-context.js';

/** The requests other agents are owed that the live turn does not serve (outside a turn, all of them). */
export function requestsAwaitingTheirOwnTurn(agentId: string): AgentRequest[] {
  try { return agentRequests(agentId).filter((r) => liveTurnServes(agentId, r) !== true); } catch { return []; }
}

// `null` means "cannot be said": a caller that REFUSES must read it as "do not refuse". A request turn serves the
// request the preflight picked; a job turn, the requests that arrived before its pickup mark.
export function liveTurnServes(agentId: string, owed: Pick<AgentRequest, 'messageId'> & Partial<Pick<AgentRequest, 'threadId' | 'fromId' | 'rowid'>>): boolean | null {
  const bag = turnContext(agentId);
  if (!bag) return null;
  if (bag.kind !== 'a2a') return false;
  if (bag.servedRequest) return bag.servedRequest.messageId === owed.messageId
    || (bag.servedRequest.threadId === owed.threadId && bag.servedRequest.fromId === owed.fromId && (owed.rowid ?? Infinity) <= (bag.pickupSeq ?? -1));
  if (bag.pickupSeq == null) return null;
  const row = getDb().prepare('SELECT seq FROM messages WHERE id = ?').get(owed.messageId) as { seq: number } | undefined;
  if (!row) return null;
  return row.seq <= bag.pickupSeq;
}

// Refuses a `send_to_agent` naming the awaiting request's thread while another turn serves it:
// any send on a thread records its request as replied, which would cancel that request's own turn.
export function requestOnThreadForAnotherTurn(agentId: string, threadId: string | undefined): { threadShort: string; refusal: string } | null {
  const token = threadId?.trim();
  if (!token) return null;
  const owed = requestsAwaitingTheirOwnTurn(agentId).find((r) => (token === r.threadId || a2aThreadTokenMatches(token, r.threadId))
    && liveTurnServes(agentId, r) === false && turnContext(agentId)?.root?.id !== r.threadId);
  if (!owed) return null;
  return {
    threadShort: owed.threadShort,
    refusal: `Not sent: the ${owed.intent} from "${owed.fromName}" on thread ${owed.threadShort} is handled on its own turn, right after this one, and answered there. `
      + `It is not part of this conversation, so do not work on it or answer it here. Nothing was sent to "${owed.fromName}" and the request stays waiting for its turn.`,
  };
}

// The thread a threadless reply-intent send belongs on: an unreplied request this turn serves, else null.
export function servedRequestThreadFrom(agentId: string, targetId: string): string | null {
  try {
    const open = agentRequests(agentId).filter((r) => r.fromId === targetId && liveTurnServes(agentId, r) !== false);
    if (new Set(open.map((r) => r.threadId)).size <= 1) return open[0]?.threadId ?? null;
    const served = turnContext(agentId)?.servedRequest;
    return open.find((r) => r.messageId === served?.messageId)?.threadId ?? null;
  } catch { return null; }
}

