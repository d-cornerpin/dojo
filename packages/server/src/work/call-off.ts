// What an end ends, behind every door that calls work off: a request, its only card, a piece and its job, or one task,
// resolved by what the row is; everything under it ends in `transition`'s cascade, in this one unit.
import { getDb } from '../db/connection.js';
import { afterCommit, withUnit } from '../db/unit.js';
import { appendWorkEvent, isTerminal, jobOfPieceSql, settlePieceWithoutResult, transition, type Actor, type PieceSettleResult } from './store.js';
import { decide, endCardsOf, refused, type DecideResult } from './done/decide.js';
import { cardOfSql, requestParts } from './ask-settlement.js';
import { clearReferencesToWork } from './work-refs.js';
import { onHelperEnded } from './task-ended.js';

/** The owner (no decider; `via` relays his words), or an agent, whose `ownerQuote` makes it his once `decide` verifies it. */
export interface CallOffBy { deciderAgentId: string | null; ownerQuote?: string; via?: string }
export const OWNER: CallOffBy = { deciderAgentId: null };

const ended = (id: string, reason: string): DecideResult => ({ kind: 'decided', to: 'abandoned', unclosed: [], text: `Ended: [${id}]. Reason: ${reason}` });

/** The request ends, and every card linked to it (any holder, handed in included) is cancelled with it. */
function endRequest(askId: string, by: CallOffBy, reason: string): DecideResult {
  const r = transition(askId, { to: 'abandoned', by: by.deciderAgentId === null ? 'owner' : 'agent', actorId: by.deciderAgentId ?? by.via ?? 'owner', reason });
  if (r.kind !== 'applied') return refused(`[${askId}] was not ended (${r.detail}).`);
  endCardsOf(askId, 'abandoned', by.deciderAgentId, reason);
  return ended(askId, reason);
}

/** THE ONE END OF A PIECE (a call-off, or the engine giving it up: `by` scheduler). A request whose last piece this was
 *  ends as his in this unit when every part of it was his; `judged` false leaves its join to the caller. */
export function endPiece(pieceId: string, reason: string, by: Actor, actorId: string): PieceSettleResult & { judged: boolean } {
  const s = settlePieceWithoutResult(pieceId, { to: 'abandoned', reason, actorId, by });
  const open = s.result.kind === 'applied' && s.join.complete && !isTerminal(s.join.parentState);
  // His end of its last working part, with nothing come back, ends the request quietly as his.
  const quiet = open && by === 'owner' && s.join.outcome === 'fail-closed' && requestParts(s.join.id) !== 'working';
  if (quiet) endRequest(s.join.id, { deciderAgentId: null, via: actorId }, reason);
  return { ...s, judged: !open || quiet };
}

export function callOff(workId: string, by: CallOffBy, reason: string): DecideResult {
  return withUnit((): DecideResult => {
    const w = getDb().prepare(`SELECT w.kind, w.root_kind AS rootKind,
        (SELECT a.id FROM work a WHERE a.kind = 'ask' AND a.agent_id = w.requester_id AND a.root_id = w.source_message_id
           AND a.state NOT IN ('done', 'failed', 'abandoned')) AS request,
        (SELECT COUNT(*) FROM work a JOIN work c ON ${cardOfSql('c', 'a')}
          WHERE a.kind = 'ask' AND a.agent_id = w.requester_id AND a.root_id = w.source_message_id) AS cards,
        (SELECT p.id FROM work p WHERE p.root_kind = 'a2a_thread' AND ${jobOfPieceSql('w', 'p')}
           AND p.state IN ('open', 'claimed', 'blocked') ORDER BY p.opened_at DESC LIMIT 1) AS piece
      FROM work w WHERE w.id = ?`).get(workId) as { kind: string; rootKind: string; request: string | null; cards: number; piece: string | null } | undefined;
    if (!w) return refused(`there is no work ${workId}.`);
    if (w.kind === 'ask') return endRequest(workId, by, reason);
    const owner = by.deciderAgentId === null || !!by.ownerQuote?.trim();
    const isPiece = w.rootKind === 'a2a_thread';
    const d = isPiece ? ended(workId, reason) : decide({ workId, deciderAgentId: by.deciderAgentId, ownerQuote: by.ownerQuote, verdict: 'cancel', reason });
    const piece = isPiece ? workId : d.kind === 'decided' && owner ? w.piece : null;
    const s = piece ? endPiece(piece, reason, owner ? 'owner' : 'agent', by.deciderAgentId ?? by.via ?? 'owner') : null;
    if (s && !s.judged) afterCommit(() => void import('../agent/a2a-transport.js').then((m) => m.resolveCompletedJoin(s.join)));
    if (isPiece && s?.result.kind !== 'applied') return refused(`[${workId}] was not ended (${s?.result.kind}).`);
    if (d.kind !== 'decided' || !owner || !w.request) return d;
    if (w.cards === 1 || requestParts(w.request) !== 'working') {
      endRequest(w.request, { deciderAgentId: null, via: by.deciderAgentId ?? undefined }, reason);
      return d;
    }
    return { ...d, text: `${d.text} Its request [${w.request}] goes on with its other parts; to end all of it on his words, work_close_request(id="${w.request}", disposition="dropped", note=<his exact words>).` };
  });
}

/** A helper ended (`terminateAgent`) has its open pieces called off: as the owner's when he removed it, else each
 *  asker's plain end. */
onHelperEnded((helperId, byOwner) => {
  const pieces = getDb().prepare(`SELECT id, agent_id AS asker FROM work WHERE root_kind = 'a2a_thread' AND assignee_agent = ?
    AND state IN ('open', 'claimed', 'blocked')`).all(helperId) as Array<{ id: string; asker: string }>;
  for (const p of pieces) callOff(p.id, byOwner ? OWNER : { deciderAgentId: p.asker }, 'its helper was ended');
});

/** The owner deletes a tracker row and its children, calling their helpers' work off as his. References are cleared
 *  children first: clearing the row's own first would null the `parent_id` the children's delete matches on. */
export function deleteTrackerRow(id: string): number {
  const db = getDb();
  let changes = 0;
  withUnit(() => {
    // A card of a request leaves the call-off record on the request's own row, which outlives the delete.
    const open = db.prepare(`SELECT w.id, w.title, a.id AS ask FROM work w LEFT JOIN work a ON a.kind = 'ask' AND a.agent_id = w.requester_id
        AND a.root_id = w.source_message_id WHERE w.kind = 'task' AND w.root_kind <> 'a2a_thread' AND (w.id = ? OR w.parent_id = ?)
      AND w.state NOT IN ('done', 'failed', 'abandoned')`).all(id, id) as Array<{ id: string; title: string | null; ask: string | null }>;
    for (const t of open) {
      if (t.ask) appendWorkEvent(t.ask, 'audit', 'owner', { marker: 'card_deleted', card_id: t.id, title: t.title });
      callOff(t.id, OWNER, 'the owner deleted it on the dashboard');
    }
    const children = (db.prepare("SELECT id FROM work WHERE parent_id = ? AND root_kind <> 'a2a_thread'").all(id) as
      Array<{ id: string }>).map(r => r.id);
    clearReferencesToWork(children);         // every reference, for the children
    db.prepare("DELETE FROM work WHERE parent_id = ? AND root_kind <> 'a2a_thread'").run(id);
    clearReferencesToWork([id]);             // every reference, for the row itself
    changes = db.prepare('DELETE FROM work WHERE id = ?').run(id).changes;
  });
  return changes;
}
