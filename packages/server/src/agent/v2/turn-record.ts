// ── The turn record (lanes & lineage P4, 2026-07-21; rebuilt PHASE-2 T2 Step 2) ──
//
// Durable answer to "what did turn N serve, and how did it end". Written at turn start
// (after the trigger claim, when kind/subject/root are known) and finalized on every exit
// path in the loop's outer finally; the recovery site closes turns that died on an exception.
//
// THREE THINGS CHANGED IN PHASE-2 T2, each because the old shape hid a fact:
//
//  1. IDENTITY IS ALLOCATED HERE, IN-TRANSACTION, from this table's own MAX — not derived by
//     the caller from `MAX(messages.turn_number)`. The old derivation is wrong whenever a
//     turn writes no messages or an agent's history is cleared: `messages` restarts at 1
//     while `turns` keeps climbing, the derived number COLLIDES with a recorded turn, and the
//     `ON CONFLICT DO UPDATE` below silently overwrote the older turn's record. Measured on
//     this box before the change: for all 61 agents with turn history, MAX(turns) >=
//     MAX(messages) — 8 agents had turn rows and NO messages at all — so moving the source to
//     `turns` only ever moves the number FORWARD, never back over a used one.
//
//  2. THE `ON CONFLICT DO UPDATE` IS DELETED. A collision is now a UNIQUE violation that
//     throws where it happened. Silently rewriting a turn record is how "537 of 4,260 turn
//     rows have no kind" happens and nobody notices.
//
//  3. `outcome` SPLIT INTO `exit_reason` + `answered`. One column meant both "why did the
//     turn end" and "has the person heard from us", and the second meaning was then
//     re-derived at ~29 sites from nine other variables. `exit_reason` is a 17-value enum
//     (CHECKed in the DB); `answered` is 0/1 NOT NULL with no default, so a writer must say.
//
// exit_reason vocabulary (the CHECK in migration 135 is the authority):
//   answered · no_reply_intended · park · handoff · delegation_exit · iteration_cap · brake ·
//   identical_call · stop · preempt · provider_error · stream_idle · abort · terminated ·
//   budget · compile_pending · unknown
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('turn-record');

export type TurnExitReason =
  | 'answered' | 'no_reply_intended' | 'park' | 'handoff' | 'delegation_exit'
  | 'iteration_cap' | 'brake' | 'identical_call' | 'stop' | 'preempt' | 'provider_error'
  | 'stream_idle' | 'abort' | 'terminated' | 'budget' | 'compile_pending' | 'unknown';

export interface TurnStartParams {
  agentId: string;
  kind: 'user' | 'a2a' | 'engine' | null;
  subjectKind: 'conv' | 'engine_event' | 'a2a_thread' | 'continuation' | 'none';
  subjectId: string | null;
  rootKind: string | null;
  rootId: string | null;
  sourceMessageId: string | null;
  convKey: string | null;
  /** P8: the spoken-stream lane, typed on the record ('voice' in-person, 'phone' live call,
   *  null for text lanes) so consumers stop re-deriving it from source flags and prose. */
  lane?: 'voice' | 'phone' | null;
}

/**
 * Allocate this agent's next turn number AND record what the turn serves, in one statement.
 *
 * Deliberately NOT best-effort: the returned number is the turn's identity, and every message,
 * receipt and delivery this turn writes is stamped with it. A caller that swallowed a failure
 * here would be stamping rows with a number that belongs to a different turn. It throws, and
 * the loop's own injury path records the death honestly.
 */
export function startTurn(params: TurnStartParams): number {
  const row = getDb().prepare(`
    INSERT INTO turns (
      agent_id, turn_number, kind, subject_kind, subject_id, root_kind, root_id,
      source_message_id, conv_key, lane, answered, effectful_calls, started_at
    )
    SELECT ?, COALESCE(MAX(turn_number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now')
      FROM turns WHERE agent_id = ?
    RETURNING turn_number
  `).get(
    params.agentId, params.kind, params.subjectKind, params.subjectId,
    params.rootKind, params.rootId, params.sourceMessageId, params.convKey,
    params.lane ?? null, params.agentId,
  ) as { turn_number: number } | undefined;

  if (!row) throw new Error(`turn allocation returned no row for agent ${params.agentId}`);
  return row.turn_number;
}

/**
 * How the turn ended. `answered` is passed explicitly rather than inferred from the exit
 * reason, because "the turn ended in a way that usually means we replied" and "a reply was
 * delivered" are exactly the two facts this platform kept confusing.
 */
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
             effectful_calls = ?, answer_message_id = ?
       WHERE agent_id = ? AND turn_number = ? AND ended_at IS NULL
    `).run(exitReason, answered ? 1 : 0, effectfulCalls, answerMessageId, agentId, turnNumber);
  } catch (err) {
    logger.warn('turn record finalize failed (non-fatal)', {
      agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A turn that died on an exception gets an honest terminal state instead of an open-ended row.
 *
 * It takes the `turn_number` its caller already holds (`AgentTurnState.turnNumber`). The old
 * signature closed EVERY open turn for the agent — which on a crash during a second, concurrent
 * turn would close the wrong one — and the caller had the number all along.
 *
 * The reason is `'unknown'`, not `'provider_error'`: the injury path does not know whether the
 * cause was the provider, the model or a bug, and 'unknown' is the enum's quarantine value.
 * Naming a cause we did not observe is the failure this project keeps finding.
 */
export function markTurnDied(agentId: string, turnNumber: number): void {
  try {
    getDb().prepare(`
      UPDATE turns SET ended_at = datetime('now'), exit_reason = 'unknown', answered = 0
       WHERE agent_id = ? AND turn_number = ? AND ended_at IS NULL
    `).run(agentId, turnNumber);
  } catch { /* best effort: an injury record must not raise a second injury */ }
}
