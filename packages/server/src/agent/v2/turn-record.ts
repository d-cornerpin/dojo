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
 * THE turn number this agent is on. G24 (research 06 requirement 24), PHASE-3 T5 rider (c).
 *
 * REPLACES four copies of `SELECT MAX(turn_number) FROM messages WHERE agent_id = ?` + 1:
 * three readers in `memory/assembler.ts` (continuity-brief window, post-compaction
 * scaffolding window, tool-result stub age) and the WRITER in `memory/compaction.ts` that
 * set the value the first two compared against. Research 06 §7's three defects — three DB
 * round-trips for one number; a value that "only advances when a row persists, so a turn
 * persisting nothing never advances"; and writer and readers deriving it at different
 * moments, so "a row landing between shifts the window by one". `turns` allocates the
 * number at turn START, so it is not derived, cannot race a write, and does not care
 * whether the turn wrote anything.
 *
 * WHY MAX AND NOT "THE OPEN TURN", measured before choosing: 139 of 3,090 live turn rows
 * have `ended_at IS NULL`, because a turn that dies never reaches `finalizeTurn` — and
 * `kevin`, the agent both prompt goldens are bound to, held an open row at turn 246 while
 * 264 had already been allocated. That reader would have answered eighteen turns stale on
 * the one agent every prompt gate watches.
 *
 * THE SHIFT, measured: on 29 of 48 agents the old expression was exactly one HIGHER; on the
 * other 19 it was LOWER by up to two, those being agents that ran turns persisting nothing.
 * The brief window keeps its shape (writer and readers move together, so `current + 3`
 * compares on one scale); the stub age is absolute and shifts 40 of 2,766 live tool rows
 * (1.4%), all toward keeping content one turn longer — correct, since a result written in
 * turn N is zero turns old in turn N, not minus one.
 */
export function currentTurnNumber(agentId: string): number {
  try {
    const row = getDb()
      .prepare('SELECT MAX(turn_number) AS max_turn FROM turns WHERE agent_id = ?')
      .get(agentId) as { max_turn: number | null } | undefined;
    return row?.max_turn ?? 0;
  } catch (err) {
    // Never kill an assembly over the clock. A 0 reads as "no turns yet", which closes the
    // brief and scaffolding windows rather than opening them — the fail-safe direction.
    logger.warn('currentTurnNumber failed; treating as 0', {
      agentId, error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * The continuity brief's window, in turns. `memory/compaction.ts` writes
 * `continuityBriefValidUntilTurn = currentTurn + this` after a compaction; the two readers in
 * `memory/assembler.ts` compare against it. It lives HERE, beside the clock, because the READ
 * side needs it to bound the value (see `readStoredTurnThreshold`) and a horizon re-declared
 * on the read side is precisely the writer/reader pair research 06 §5 catalogues.
 */
export const CONTINUITY_BRIEF_HORIZON_TURNS = 3;

/**
 * Read a stored turn threshold, WITH AN UPPER SANITY BOUND. PHASE-3 T6.
 *
 * ── THE CLASS, MEASURED ON THE LIVE DEV BODY (2026-08-01) ────────────────────────────────
 * A threshold is written as `currentTurn + horizon` and read as `currentTurn < threshold`.
 * It had no upper bound, so a value from a DIFFERENT numbering era never expires — it is
 * permanently in the future, and the lane it gates fires on every turn for the rest of the
 * agent's life. Three of the five agents holding one were in that state:
 *
 *     agent      stored   current turn   verdict before      verdict after
 *     kevin        1598            264   valid for 1,334     expired
 *     healer        122              9   valid for 113       expired
 *     imaginer       19              0   valid for 19        expired
 *     dreamer        24             27   expired             expired
 *     kelly          11            730   expired             expired
 *
 * `kevin` is the agent both prompt goldens are bound to, so its brief and its whole
 * post-compaction scaffolding block had been permanently admitted.
 *
 * ── WHERE "ABSURD" COMES FROM ───────────────────────────────────────────────────────────
 * NOT invented (#14): from the WRITER'S OWN HORIZON. The writer can only ever store
 * `currentTurn + horizon`, and `currentTurn` never decreases, so at any later read a value
 * above `currentTurn + horizon` is one no writer on this clock could have produced. Equality
 * is deliberately INSIDE the bound: a brief written this instant reads back at exactly
 * `currentTurn + horizon` and must stay valid.
 *
 * Returns `null` — the same answer as "absent" — so both readers treat a fossil as EXPIRED
 * without either of them learning a new branch.
 */
export function readStoredTurnThreshold(
  raw: unknown,
  currentTurn: number,
  horizonTurns: number,
): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  if (raw > currentTurn + horizonTurns) {
    logger.warn('stored turn threshold is beyond the writer\'s own horizon; reading it as expired', {
      stored: raw, currentTurn, horizonTurns,
    });
    return null;
  }
  return raw;
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
             effectful_calls = MAX(effectful_calls, ?), answer_message_id = ?
       WHERE agent_id = ? AND turn_number = ? AND ended_at IS NULL
    `).run(exitReason, answered ? 1 : 0, effectfulCalls, answerMessageId, agentId, turnNumber);
  } catch (err) {
    logger.warn('turn record finalize failed (non-fatal)', {
      agentId, turnNumber, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * PHASE-2 T3 — `effectful_calls`, made DURABLE the moment the effect happens.
 *
 * T2 landed the column and persisted the loop's in-memory counter at finalize. That is the
 * right number on every path except the one the counter exists for: a process KILLED
 * between the effect and the end of the turn never reaches finalize, so the column reads 0
 * and the boot reconciliation would hand the ask back and do the effect a second time —
 * which is precisely what P6b forbids ("a duplicate send is worse than a stranded ask").
 * So the count is written HERE, beside the effect, and `finalizeTurn` can only ever raise
 * it (`MAX`), never lower it: two observation points of one fact, and the fail-safe
 * direction is the only one they can disagree in.
 *
 * Deliberately not best-effort-silent: a failure to record an effect is logged, because the
 * consequence of losing this number is a duplicated side effect.
 */
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
