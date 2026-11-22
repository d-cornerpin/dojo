// What an end ends, behind every door that calls work off. The row is resolved by what it is, never by who holds it:
// a request, its only card (which stands for it), a piece and the job on it, or one task. Everything under it ends
// in `transition`'s cascade, in this one unit; after commit only live turns are stopped (`endTheWorkUnder`).
import { getDb } from '../db/connection.js';
import { afterCommit, withUnit } from '../db/unit.js';
import { isTerminal, settlePieceWithoutResult, transition } from './store.js';
import { decide, type DecideResult } from './done/decide.js';
import { endedByHim } from './ask-settlement.js';
import { clearReferencesToWork } from './work-refs.js';

/** The owner (`deciderAgentId` null; `via` the agent relaying his words), or an agent, whose `ownerQuote` makes it his
 *  once `decide` verifies it. */
export interface CallOffBy { deciderAgentId: string | null; ownerQuote?: string; via?: string }
export const OWNER: CallOffBy = { deciderAgentId: null };

const refused = (text: string): DecideResult => ({ kind: 'refused', text: `Refused: ${text}` });
const ended = (id: string, reason: string): DecideResult => ({ kind: 'decided', to: 'abandoned', unclosed: [], text: `Ended: [${id}]. Reason: ${reason}` });

/** The request ends, and every card linked to it (any holder, handed in included) is cancelled with it. */
function endRequest(askId: string, by: CallOffBy, reason: string): DecideResult {
  const r = transition(askId, { to: 'abandoned', by: by.deciderAgentId === null ? 'owner' : 'agent', actorId: by.deciderAgentId ?? by.via ?? 'owner', reason });
  if (r.kind !== 'applied') return refused(`[${askId}] was not ended (${r.detail}).`);
  const cards = getDb().prepare(`SELECT c.id FROM work a JOIN work c ON c.kind = 'task' AND c.root_kind <> 'a2a_thread'
      AND c.requester_id = a.agent_id AND c.source_message_id = a.root_id AND c.state NOT IN ('done', 'failed', 'abandoned') WHERE a.id = ?`)
    .all(askId) as Array<{ id: string }>;
  for (const c of cards) decide({ workId: c.id, deciderAgentId: by.deciderAgentId, verdict: 'cancel', reason });
  return ended(askId, reason);
}

/** A helper's piece ends; its request, once nothing of it is left, ends as his here or is judged after commit. */
function endPiece(pieceId: string, by: CallOffBy, reason: string): DecideResult {
  const owner = by.deciderAgentId === null;
  const s = settlePieceWithoutResult(pieceId, { to: 'abandoned', reason, actorId: by.deciderAgentId ?? by.via ?? 'owner', by: owner ? 'owner' : 'agent' });
  if (s.result.kind !== 'applied') return refused(`[${pieceId}] was not ended (${s.result.kind}).`);
  if (s.join.complete && !isTerminal(s.join.parentState)) {
    if (owner && endedByHim(s.join.id)) endRequest(s.join.id, by, reason);
    else afterCommit(() => void import('../agent/a2a-transport.js').then((m) => m.resolveCompletedJoin(s.join)));
  }
  return ended(pieceId, reason);
}

/** THE CALL-OFF (header). */
export function callOff(workId: string, by: CallOffBy, reason: string): DecideResult {
  return withUnit((): DecideResult => {
    const w = getDb().prepare(`SELECT w.kind, w.root_kind AS rootKind,
        (SELECT a.id FROM work a WHERE a.kind = 'ask' AND a.agent_id = w.requester_id AND a.root_id = w.source_message_id
           AND a.state NOT IN ('done', 'failed', 'abandoned')) AS request,
        (SELECT COUNT(*) FROM work c WHERE c.kind = 'task' AND c.root_kind <> 'a2a_thread' AND c.requester_id = w.requester_id
           AND c.source_message_id = w.source_message_id) AS cards,
        (SELECT p.id FROM work p WHERE p.root_kind = 'a2a_thread' AND p.root_id = w.a2a_thread_id AND p.assignee_agent = w.agent_id
           AND p.state IN ('open', 'claimed', 'blocked') ORDER BY p.opened_at DESC LIMIT 1) AS piece
      FROM work w WHERE w.id = ?`).get(workId) as { kind: string; rootKind: string; request: string | null; cards: number; piece: string | null } | undefined;
    if (!w) return refused(`there is no work ${workId}.`);
    if (w.kind === 'ask') return endRequest(workId, by, reason);
    if (w.rootKind === 'a2a_thread') return endPiece(workId, by, reason);
    const d = decide({ workId, deciderAgentId: by.deciderAgentId, ownerQuote: by.ownerQuote, verdict: 'cancel', reason });
    if (d.kind !== 'decided' || (by.deciderAgentId !== null && !by.ownerQuote?.trim())) return d;
    const his: CallOffBy = { deciderAgentId: null, via: by.deciderAgentId ?? undefined };
    if (w.piece) endPiece(w.piece, his, reason);
    if (w.request && (w.cards === 1 || endedByHim(w.request))) endRequest(w.request, his, reason);
    else if (w.request) return { ...d, text: `${d.text} Its request [${w.request}] goes on with its other parts; to end all of it on his words, work_close_request(id="${w.request}", disposition="dropped", note=<his exact words>).` };
    return d;
  });
}

/**
 * The owner deletes a tracker row and its children (deeper descendants are detached). What each open task was is called
 * off as his first (`callOff`), and the helpers' pieces under it stay, ended, so a late answer is still refused. The
 * helper runs twice, children first, because it nulls `parent_id` on everything pointing into its set: one call for both
 * would leave the `WHERE parent_id = ?` delete matching nothing.
 */
export function deleteTrackerRow(id: string): number {
  const db = getDb();
  let changes = 0;
  withUnit(() => {
    const open = db.prepare(`SELECT id FROM work WHERE kind = 'task' AND root_kind <> 'a2a_thread' AND (id = ? OR parent_id = ?)
      AND state NOT IN ('done', 'failed', 'abandoned')`).all(id, id) as Array<{ id: string }>;
    for (const t of open) callOff(t.id, OWNER, 'the owner deleted it on the dashboard');
    const children = (db.prepare("SELECT id FROM work WHERE parent_id = ? AND root_kind <> 'a2a_thread'").all(id) as
      Array<{ id: string }>).map(r => r.id);
    clearReferencesToWork(children);         // every reference, for the children
    db.prepare("DELETE FROM work WHERE parent_id = ? AND root_kind <> 'a2a_thread'").run(id);
    clearReferencesToWork([id]);             // every reference, for the row itself
    changes = db.prepare('DELETE FROM work WHERE id = ?').run(id).changes;
  });
  return changes;
}
