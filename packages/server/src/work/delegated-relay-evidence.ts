// When the engine's relay of a delegated answer is also the answer to a second, mid-turn ask (B).
// `qualifyingDelivery` and the `recordOwedInterruptSubjects` water-mark fence cannot see it.
// The relay is B's answer only when all hold, each read off a record, never prose:
//   1. the delegating send is a `send_to_agent` delivery stamped with the `owed_interrupt` turn;
//   2. it came after B reached the model (B's row and the `recordOwedAskShown` mark);
//   3. the engine's join relay for that join reached B's conversation after B arrived.
// The caller adds a fourth: the turn that served B again ended in the model's silence.
// The close itself is `settleAsk`'s; this file only reads, plus the one audit mark below.

import { getDb } from '../db/connection.js';
import { appendWorkEvent, askIdForMessage } from './store.js';

export const OWED_ASK_SHOWN_MARKER = 'owed_ask_shown_to_model';

export interface OwedAskRow {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  opened_at: number;
  root_id: string;
}

/** Did the turn end in the model's own silence (`no_reply_intended`)? Cuts, stops and answers never qualify. */
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

export function relayThatAnsweredOwedAsk(
  ask: OwedAskRow, relayTools: readonly string[],
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
    const shown = (db.prepare(
      `SELECT MAX(json_extract(payload, '$.messageRowid')) AS r FROM work_events
        WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.marker') = ?
          AND json_extract(payload, '$.turnNumber') = ?`,
    ).get(ask.id, OWED_ASK_SHOWN_MARKER, turn) as { r: number | null } | undefined)?.r ?? 0;
    const reached = Math.max(askRow, shown);

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
      // The piece id embeds its thread (`piece:<parent>:<thread>`), which survives a hand-off moving `root_id`.
      const piece = db.prepare(
        `SELECT parent_id FROM work
          WHERE kind = 'task' AND agent_id = @agentId AND parent_id IS NOT NULL
            AND substr(id, -(length(@thread) + 1)) = ':' || @thread`,
      ).get({ agentId: ask.agent_id, thread: send.thread }) as { parent_id: string } | undefined;
      if (!piece) continue;
      const relay = db.prepare(
        `SELECT d.id AS id, d.tool AS tool FROM deliveries d
          WHERE d.agent_id = @agentId AND d.conversation_id = @conv AND d.outcome = 'delivered'
            AND d.tool IN (${relaySql}) AND json_extract(d.payload_json, '$.joinId') = @joinId
            AND unixepoch(d.created_at) >= @floorSec
          ORDER BY d.rowid ASC LIMIT 1`,
      ).get({
        agentId: ask.agent_id, conv: ask.conversation_id, joinId: piece.parent_id,
        floorSec: Math.floor(ask.opened_at / 1000), ...relayBind,
      }) as { id: string; tool: string } | undefined;
      if (relay) return relay;
    }
  }
  return null;
}

/** Marks when the model was pointed at an owed ask: only a later delegation is answered by the relay. */
export function recordOwedAskShown(_agentId: string, owedMessageIds: readonly string[], turnNumber: number): void {
  const db = getDb();
  // The newest row anywhere: the model's own send lands on the peer's side of the table.
  const mark = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS r FROM messages').get() as { r: number }).r;
  for (const messageId of owedMessageIds) {
    const workId = askIdForMessage(messageId);
    if (!db.prepare('SELECT 1 FROM work WHERE id = ?').get(workId)) continue;
    appendWorkEvent(workId, 'audit', 'engine', { marker: OWED_ASK_SHOWN_MARKER, turnNumber, messageRowid: mark });
  }
}

/** At finalize: model silence on the re-served ask plus a relay that answers it, else null. */
export function delegatedRelayEvidence(
  ask: OwedAskRow, turnNumber: number | null, relayTools: readonly string[],
): { id: string; tool: string } | null {
  return turnEndedInModelSilence(ask.agent_id, turnNumber)
    ? relayThatAnsweredOwedAsk(ask, relayTools)
    : null;
}
