// ── The turn record (lanes & lineage P4, 2026-07-21) ──
//
// Durable answer to "what did turn N serve, and how did it end". Written by
// the loop at turn start (after the trigger claim, when kind/subject/root are
// known) and finalized on every exit path in the loop's outer finally; the
// runtime's recovery site stamps outcome='error' for turns that died on an
// exception before finalize. Everything is best-effort: the record must never
// block or throw into a live turn.
//
// outcome vocabulary: answered | no_reply | parked | handoff | aborted |
// brake | error.
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('turn-record');

export function recordTurnStart(params: {
  agentId: string;
  turnNumber: number;
  kind: 'user' | 'a2a' | 'engine' | null;
  subjectKind: 'conv' | 'engine_event' | 'a2a_thread' | 'continuation' | 'none';
  subjectId: string | null;
  rootKind: string | null;
  rootId: string | null;
  sourceMessageId: string | null;
  convKey: string | null;
}): void {
  try {
    getDb().prepare(`
      INSERT INTO turns (agent_id, turn_number, kind, subject_kind, subject_id, root_kind, root_id, source_message_id, conv_key, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(agent_id, turn_number) DO UPDATE SET
        kind = excluded.kind, subject_kind = excluded.subject_kind, subject_id = excluded.subject_id,
        root_kind = excluded.root_kind, root_id = excluded.root_id,
        source_message_id = excluded.source_message_id, conv_key = excluded.conv_key
    `).run(
      params.agentId, params.turnNumber, params.kind, params.subjectKind, params.subjectId,
      params.rootKind, params.rootId, params.sourceMessageId, params.convKey,
    );
  } catch (err) {
    logger.warn('turn record start failed (non-fatal)', { agentId: params.agentId, turnNumber: params.turnNumber, error: err instanceof Error ? err.message : String(err) });
  }
}

export function finalizeTurn(agentId: string, turnNumber: number, outcome: string, answerMessageId: string | null): void {
  try {
    getDb().prepare(`
      UPDATE turns SET ended_at = datetime('now'), outcome = ?, answer_message_id = ?
      WHERE agent_id = ? AND turn_number = ? AND ended_at IS NULL
    `).run(outcome, answerMessageId, agentId, turnNumber);
  } catch (err) {
    logger.warn('turn record finalize failed (non-fatal)', { agentId, turnNumber, error: err instanceof Error ? err.message : String(err) });
  }
}

// Runtime recovery: a turn that threw before finalize gets an honest terminal
// state instead of an open-ended row.
export function markLatestTurnError(agentId: string): void {
  try {
    getDb().prepare(`
      UPDATE turns SET ended_at = datetime('now'), outcome = 'error'
      WHERE agent_id = ? AND ended_at IS NULL
    `).run(agentId);
  } catch { /* best effort */ }
}
