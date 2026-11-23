// Turn record: what each turn served and how it ended. TurnExitReason must match migration 184's CHECK;
// the census test eight-exit-reasons-get-their-writers.test.ts refuses a member with no writer.
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('turn-record');

export type TurnExitReason =
  | 'answered' | 'no_reply_intended' | 'park' | 'handoff'
  | 'iteration_cap' | 'brake' | 'identical_call' | 'stop' | 'preempt' | 'provider_error'
  | 'stream_idle' | 'abort' | 'terminated' | 'budget' | 'unknown';

/** Exits a turn site may latch as engine- or owner-imposed (engine-exit.ts); not the model's own exits.
 * `brake` and `identical_call` are absent: the recorder derives them from the tool phase's state. */
export type EngineCutReason = Extract<TurnExitReason,
  'stop' | 'preempt' | 'abort' | 'terminated' | 'budget' | 'provider_error' | 'stream_idle' | 'iteration_cap'>;

export interface TurnStartParams {
  agentId: string;
  kind: 'user' | 'a2a' | 'engine' | null;
  subjectKind: 'conv' | 'engine_event' | 'a2a_thread' | 'continuation' | 'none';
  subjectId: string | null;
  rootKind: string | null;
  rootId: string | null;
  sourceMessageId: string | null;
  convKey: string | null;
  /** Spoken-stream lane: 'voice' in person, 'phone' on a live call, null for text lanes. */
  lane?: 'voice' | 'phone' | null;
  pickupSeq?: number | null;   // the last message row that existed when the turn picked up its work
}

/** Allocate the next turn number from `turns` (never `messages`, which restarts on a history clear) and
 * record the turn in one statement. Throws on failure or collision: this turn's rows all carry it. */
export function startTurn(params: TurnStartParams): number {
  const row = getDb().prepare(`
    INSERT INTO turns (
      agent_id, turn_number, kind, subject_kind, subject_id, root_kind, root_id,
      source_message_id, conv_key, lane, answered, effectful_calls, started_at, pickup_seq
    )
    SELECT ?, COALESCE(MAX(turn_number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'), ?
      FROM turns WHERE agent_id = ?
    RETURNING turn_number
  `).get(
    params.agentId, params.kind, params.subjectKind, params.subjectId,
    params.rootKind, params.rootId, params.sourceMessageId, params.convKey,
    params.lane ?? null, params.pickupSeq ?? null, params.agentId,
  ) as { turn_number: number } | undefined;

  if (!row) throw new Error(`turn allocation returned no row for agent ${params.agentId}`);
  return row.turn_number;
}

/** The turn this agent is on: MAX of `turns`, not the open row (a killed process leaves its turn open). */
export function currentTurnNumber(agentId: string): number {
  try {
    const row = getDb()
      .prepare('SELECT MAX(turn_number) AS max_turn FROM turns WHERE agent_id = ?')
      .get(agentId) as { max_turn: number | null } | undefined;
    return row?.max_turn ?? 0;
  } catch (err) {
    // Never fail a caller over the clock; 0 reads as "no turns yet", the fail-safe direction.
    logger.warn('currentTurnNumber failed; treating as 0', {
      agentId, error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/** How the turn ended. `answered` is passed, never inferred: an exit reason does not prove a reply. */
export function finalizeTurn(
  agentId: string,
  turnNumber: number,
  exitReason: TurnExitReason,
  answered: boolean,
  answerMessageId: string | null,
  effectfulCalls = 0,
): void {
  try {
    getDb().prepare(`
      UPDATE turns
         SET ended_at = datetime('now'), exit_reason = ?, answered = ?,
             effectful_calls = MAX(effectful_calls, ?), answer_message_id = ?
       WHERE agent_id = ? AND turn_number = ? AND ended_at IS NULL
    `).run(exitReason, answered ? 1 : 0, effectfulCalls, answerMessageId, agentId, turnNumber);
  } catch (err) {
    logger.warn('turn record finalize failed (non-fatal)', {
      agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Count an effect when it happens, or a process killed before finalize reads 0 and boot reconciliation
 * redoes it; `finalizeTurn` only raises the count (MAX). Failures log: a lost count duplicates effects. */
export function bumpEffectfulCalls(agentId: string, turnNumber: number, by = 1): void {
  if (by <= 0) return;
  try {
    getDb().prepare(
      'UPDATE turns SET effectful_calls = effectful_calls + ? WHERE agent_id = ? AND turn_number = ?',
    ).run(by, agentId, turnNumber);
  } catch (err) {
    logger.warn('effectful-call count not recorded — a crash here could duplicate an effect', {
      agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Close a turn that died; 'unknown' unless the caller passes the cut it observed (never a guess).
 * This and `finalizeTurn` both skip ended rows, so whichever runs first decides the reason. */
export function markTurnDied(
  agentId: string, turnNumber: number, reason: TurnExitReason = 'unknown',
): void {
  try {
    getDb().prepare(`
      UPDATE turns SET ended_at = datetime('now'), exit_reason = ?, answered = 0
       WHERE agent_id = ? AND turn_number = ? AND ended_at IS NULL
    `).run(reason, agentId, turnNumber);
  } catch { /* best effort: an injury record must not raise a second injury */ }
}

/** Close every open turn of ONE agent as `terminated`, returning the count. Callers: the boot sweep
 * (agent-status.ts) and the stale-row reaper (runtime.ts). One agent only: no unjudged run's turns close. */
export function markTurnsTerminated(agentId: string): number {
  try {
    const r = getDb().prepare(`
      UPDATE turns SET ended_at = datetime('now'), exit_reason = 'terminated', answered = 0
       WHERE agent_id = ? AND ended_at IS NULL
    `).run(agentId);
    return r.changes;
  } catch (err) {
    logger.warn('a finished run\'s open turn rows could not be closed and stay unended',
      { agentId, error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}
