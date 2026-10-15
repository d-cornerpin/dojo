// t163 — WHEN THE ENGINE'S RELAY OF A DELEGATED ANSWER IS THE ANSWER TO A SECOND, MID-TURN ASK.
//
// MEASURED (Run 9, S3): the owner sent ask A, then — while the turn on A was running — ask B. The
// model delegated B to a helper (the join is opened under the turn's trigger, A, because that is
// what the turn was serving). The helper's answer reached the owner through the engine's relay,
// and then ask B was served again, the model — which could see the relay — chose silence, the
// engine re-opened B ("its turn finalized without delivering an answer"), and a third turn
// answered B in full. One answer, told twice.
//
// WHY THE ORDINARY EVIDENCE CANNOT SEE IT. `qualifyingDelivery` wants a delivery stamped with the
// finalizing turn, and `recordOwedInterruptSubjects` (T25) deliberately fences off every delivery
// at or below the water mark taken when B was recorded owed. Both are right for what they were
// built for. Neither can recognise a relay that is B's answer by CONSTRUCTION.
//
// THE RULE (the owner's: answer once; when in doubt answer again rather than fall silent). The
// relay is B's answer only when ALL of these hold, each read off a record, never off prose:
//   1. the join was opened by the turn that owed B — the delegating send is a `send_to_agent`
//      delivery stamped with that turn (`owed_interrupt`'s own turn number);
//   2. the send came AFTER B reached the model — after B's own row and after the owed-interrupt
//      steer pointed the model at it (`recordOwedAskShown`), so a delegation composed before the
//      model had seen B is never credited to B;
//   3. the relay (the engine's own join relay, for THAT join) reached B's conversation after B
//      arrived.
// The caller adds the fourth condition, which is not this file's to judge: the turn that served
// B again ended in the MODEL's silence. An engine cut, or a model that answers, never gets here.
//
// The close itself is `settleAsk`'s (its one `done` site, `ask-done-census.test.ts`); this file only
// reads, plus the one audit mark below.

import { getDb } from '../db/connection.js';
import { appendWorkEvent, askIdForMessage } from './store.js';

/** The audit marker `recordOwedAskShown` writes and this file reads — one name, two sides. */
export const OWED_ASK_SHOWN_MARKER = 'owed_ask_shown_to_model';

export interface OwedAskRow {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  opened_at: number;
  /** An ask's root is the owner message that opened it. */
  root_id: string;
}

/** Did the turn END IN THE MODEL'S OWN SILENCE (`no_reply_intended`)? An engine cut, a stop, a
 *  park or an answer is a different exit and never qualifies. */
export function turnEndedInModelSilence(agentId: string, turnNumber: number | null): boolean {
  if (turnNumber == null) return false;
  try {
    const r = getDb().prepare(
      'SELECT exit_reason FROM turns WHERE agent_id = ? AND turn_number = ?',
    ).get(agentId, turnNumber) as { exit_reason: string | null } | undefined;
    return r?.exit_reason === 'no_reply_intended';
  } catch {
    return false;
  }
}

/** The engine's relay of a delegated answer that is also this owed ask's answer, or null. */
export function relayThatAnsweredOwedAsk(
  ask: OwedAskRow, relayTools: readonly string[], joinDetail: (joinId: string) => string,
): { id: string; tool: string } | null {
  if (ask.conversation_id == null || relayTools.length === 0) return null;
  const db = getDb();
  const owedTurns = (db.prepare(
    `SELECT DISTINCT json_extract(payload, '$.turnNumber') AS t FROM work_events
      WHERE work_id = ? AND kind = 'owed_interrupt'`,
  ).all(ask.id) as Array<{ t: number | null }>).map((r) => r.t).filter((t): t is number => t != null);
  if (owedTurns.length === 0) return null;

  const askRow = (db.prepare('SELECT seq AS r FROM messages WHERE id = ?').get(ask.root_id) as
    { r: number } | undefined)?.r ?? 0;
  const relaySql = relayTools.map((_, i) => `@r${i}`).join(', ');
  const relayBind: Record<string, unknown> = {};
  relayTools.forEach((t, i) => { relayBind[`r${i}`] = t; });

  for (const turn of owedTurns) {
    // When B reached the model: after B's own row, and after the steer that pointed at it.
    const shown = (db.prepare(
      `SELECT MAX(json_extract(payload, '$.messageRowid')) AS r FROM work_events
        WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.marker') = ?
          AND json_extract(payload, '$.turnNumber') = ?`,
    ).get(ask.id, OWED_ASK_SHOWN_MARKER, turn) as { r: number | null } | undefined)?.r ?? 0;
    const reached = Math.max(askRow, shown);

    // The delegating sends of THAT turn, after B reached the model.
    const sends = db.prepare(
      `SELECT m.a2a_thread_id AS thread
         FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE d.agent_id = @agentId AND d.turn_number = @turn
          AND d.tool = 'send_to_agent' AND d.outcome = 'delivered'
          AND m.source_agent_id = @agentId AND m.a2a_thread_id IS NOT NULL
          AND m.a2a_intent IN ('QUESTION','ASSIGN','BLOCK')
          AND m.seq > @reached`,
    ).all({ agentId: ask.agent_id, turn, reached }) as Array<{ thread: string }>;

    for (const send of sends) {
      // The piece's id embeds the thread it was opened on (`piece:<parent>:<thread>`), and keeps it
      // when a hand-off later moves the piece's `root_id`.
      const piece = db.prepare(
        `SELECT parent_id FROM work
          WHERE kind = 'task' AND agent_id = @agentId AND parent_id IS NOT NULL
            AND substr(id, -(length(@thread) + 1)) = ':' || @thread`,
      ).get({ agentId: ask.agent_id, thread: send.thread }) as { parent_id: string } | undefined;
      if (!piece) continue;
      const relay = db.prepare(
        `SELECT d.id AS id, d.tool AS tool FROM deliveries d
          WHERE d.agent_id = @agentId AND d.conversation_id = @conv AND d.outcome = 'delivered'
            AND d.tool IN (${relaySql}) AND d.detail LIKE @detail
            AND unixepoch(d.created_at) >= @floorSec
          ORDER BY d.rowid ASC LIMIT 1`,
      ).get({
        agentId: ask.agent_id, conv: ask.conversation_id, detail: `%${joinDetail(piece.parent_id)}%`,
        floorSec: Math.floor(ask.opened_at / 1000), ...relayBind,
      }) as { id: string; tool: string } | undefined;
      if (relay) return relay;
    }
  }
  return null;
}

/**
 * t163 — THE MOMENT THE ENGINE POINTED THE MODEL AT AN OWED ASK, written down. The owed-interrupt
 * steer calls this just before it files the steer. `recordOwedInterruptSubjects` cannot say it
 * (it runs once a reply exists, after any delegation); the engine's relay can be an owed ask's
 * answer only for a delegation made AFTER this mark. Best-effort by construction: with no mark the
 * rule falls back to the ask's own arrival.
 */
export function recordOwedAskShown(_agentId: string, owedMessageIds: readonly string[], turnNumber: number): void {
  const db = getDb();
  // The newest row anywhere: the model's own send lands on the PEER's side of the table.
  const mark = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS r FROM messages').get() as { r: number }).r;
  for (const messageId of owedMessageIds) {
    const workId = askIdForMessage(messageId);
    if (!db.prepare('SELECT 1 FROM work WHERE id = ?').get(workId)) continue;
    appendWorkEvent(workId, 'audit', 'engine', { marker: OWED_ASK_SHOWN_MARKER, turnNumber, messageRowid: mark });
  }
}

/**
 * The settlement authority's extra source of evidence, at turn finalize only: the turn that served
 * this owed ask AGAIN ended in the model's own silence, and the engine's relay of the delegated
 * answer is this ask's answer. `settleAsk` closes the ask on it through its ONE close site; null
 * leaves the ladder exactly as it was (re-open, visible, one rung).
 */
export function delegatedRelayEvidence(
  ask: OwedAskRow, turnNumber: number | null, relayTools: readonly string[],
  joinDetail: (joinId: string) => string,
): { id: string; tool: string } | null {
  return turnEndedInModelSilence(ask.agent_id, turnNumber)
    ? relayThatAnsweredOwedAsk(ask, relayTools, joinDetail)
    : null;
}
