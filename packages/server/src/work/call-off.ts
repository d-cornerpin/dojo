// What an end ends, behind every door that calls work off: a request, its only card, a piece and its job, or one task,
// resolved by what the row is; everything under it ends in `transition`'s cascade, in this one unit.
import { getDb } from '../db/connection.js';
import { afterCommit, withUnit } from '../db/unit.js';
import { isTerminal, settlePieceWithoutResult, transition, type Actor, type PieceSettleResult } from './store.js';
import { decide, refused, type DecideResult } from './done/decide.js';
import { endedByHim } from './ask-settlement.js';
import { clearReferencesToWork } from './work-refs.js';

/** The owner (no decider; `via` relays his words), or an agent, whose `ownerQuote` makes it his once `decide` verifies it. */
export interface CallOffBy { deciderAgentId: string | null; ownerQuote?: string; via?: string }
export const OWNER: CallOffBy = { deciderAgentId: null };

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

/** THE ONE END OF A PIECE (a call-off, or the engine giving it up: `by` scheduler). A request whose last piece this was
 *  ends as his in this unit when every part of it was his; `judged` false leaves its join to the caller. */
export function endPiece(pieceId: string, reason: string, by: Actor, actorId: string): PieceSettleResult & { judged: boolean } {
  const s = settlePieceWithoutResult(pieceId, { to: 'abandoned', reason, actorId, by });
  const open = s.result.kind === 'applied' && s.join.complete && !isTerminal(s.join.parentState);
  const his = open && by === 'owner' && endedByHim(s.join.id) && endRequest(s.join.id, { deciderAgentId: null, via: actorId }, reason).kind === 'decided';
  return { ...s, judged: !open || his };
}

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
    const owner = by.deciderAgentId === null || !!by.ownerQuote?.trim();
    const isPiece = w.rootKind === 'a2a_thread';
    const d = isPiece ? ended(workId, reason) : decide({ workId, deciderAgentId: by.deciderAgentId, ownerQuote: by.ownerQuote, verdict: 'cancel', reason });
    const piece = isPiece ? workId : d.kind === 'decided' && owner ? w.piece : null;
    const s = piece ? endPiece(piece, reason, owner ? 'owner' : 'agent', by.deciderAgentId ?? by.via ?? 'owner') : null;
    if (s && !s.judged) afterCommit(() => void import('../agent/a2a-transport.js').then((m) => m.resolveCompletedJoin(s.join)));
    if (isPiece && s?.result.kind !== 'applied') return refused(`[${workId}] was not ended (${s?.result.kind}).`);
    if (d.kind !== 'decided' || !owner || !w.request) return d;
    if (w.cards === 1 || endedByHim(w.request)) { endRequest(w.request, { deciderAgentId: null, via: by.deciderAgentId ?? undefined }, reason); return d; }
    return { ...d, text: `${d.text} Its request [${w.request}] goes on with its other parts; to end all of it on his words, work_close_request(id="${w.request}", disposition="dropped", note=<his exact words>).` };
  });
}

/** A helper's removal or end calls off its open pieces: as the owner's when `by` is his, else each asker's plain end. */
export function callOffHelpersWork(helperId: string, by?: CallOffBy): void {
  const pieces = getDb().prepare(`SELECT id, agent_id AS asker FROM work WHERE root_kind = 'a2a_thread' AND assignee_agent = ?
    AND state IN ('open', 'claimed', 'blocked')`).all(helperId) as Array<{ id: string; asker: string }>;
  for (const p of pieces) callOff(p.id, by ?? { deciderAgentId: p.asker }, 'its helper was ended');
}

/**
 * The owner deletes a tracker row and its children (deeper descendants are detached), so a helper's work on them
 * is called off as his. The helper runs twice, children first, because it nulls `parent_id` on everything pointing
 * into its set: one call for both would leave the `WHERE parent_id = ?` delete matching nothing.
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
