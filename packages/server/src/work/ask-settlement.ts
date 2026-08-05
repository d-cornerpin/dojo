// ════════════════════════════════════════════════════════════════════════════════
// THE SETTLEMENT AUTHORITY FOR OWNER ASKS — SWEEP-A TB1 (`DESIGN-2BUGS/DESIGN.md` §1).
//
// ONE function decides whether an owner's ask is settled. Before this file, FOUR did
// (verify report M2, measured at `3439240`): the delivery-transaction closer, the boot
// reconciler's answered arm, the model's own `work_close_request` tool, and the join relay —
// each at a different moment, each with partial evidence, none aware of the others. The
// teardown batch-claim then wrote `claimed` AFTER the only closer scoped to that turn had
// already swept, so a whole class of answered asks was stranded `claimed` for ever: 36
// historical rows on the dev box, reproduced 4/4 by the kit scenario `ask-burst-always-settles`.
//
// ── THE RULE, STATED ONCE ──
// An ask closes only against a recorded DELIVERED delivery in the ask's own conversation
// that the ask entered the model's context BEFORE — and only if the ask row carries no
// unresolved delegation (`remaining_children > 0` or `compile_pending = 1` HOLDS it). An ask
// that got no qualifying delivery is returned to `open` — visible again — never left
// `claimed`, never closed.
//
// ── THE GOVERNING PRIORITY (owner ruling, 2026-08-05) ──
// "The user asks the agent to do something and it does it. Period." Every ambiguous-evidence
// tie-break in this file errs toward SERVING THE ASK AGAIN. Worst case the owner hears an
// answer twice; it never errs toward silence, a parked ticket or a quiet close. The
// no-double-answer protection the teardown batch-claim was built for (F9) survives strictly
// SUBORDINATE to that, and it survives as a PROPERTY rather than a mechanism: an answer
// delivered closes every ask it settled, with the receipt on the row, so the drain has
// nothing left to re-serve. Dedup is the record being correct.
//
// ⚠ WHAT THIS REVERSES, AND WHO REVERSED IT. `closeAsksForDelivery`'s own header recorded the
// opposite trade-off — an ask left `claimed` is "visible and inert … nobody is re-answered" —
// and P6b's revert refusal records the same direction ("a duplicate send is worse than a
// stranded ask"). The owner overruled that direction on 2026-08-05, in those words. The
// residual it buys is stated rather than hidden: a turn that executed a non-idempotent tool
// call and then delivered NOTHING hands its ask back, so the re-serve can repeat that call.
// The transition reason names the turn so the repeat is findable. P6b's own function
// (`revertAskClaimOnAbort`) is untouched and still refuses on the ABORT path; this is the
// turn-boundary adjudication, and at the boundary the owner's ruling governs.
//
// ── WHAT LIVES HERE AND WHAT DOES NOT ──
// The evidence predicate lives in `settleAsk` and nowhere else. The three invocation
// wrappers below carry SCOPE (which rows to ask about) and no decision of their own:
//   (a) `settleAsksForDelivery` — inside `recordDelivery`'s existing transaction, so the
//       delivery row and the close it causes still commit together (PHASE-4 T2's unit);
//   (b) `settleAsksAtTurnFinalize` — the final adjudicator, over every ask the turn CLAIMED
//       or that entered its ASSEMBLED CONTEXT. Structural invariant: no ask remains
//       `claimed` by a finalized turn;
//   (c) `reconcileOrphanedClaims` — boot, unchanged in trigger and window; only its
//       answered arm's decision is now shared.
// The join arm (`settleJoinDelivered`) is the same rule invoked from the relay and is folded
// in by SWEEP-A TB2, which also owns the join DRIVING, the escalation ladder and everything
// `blocked` beyond the hold written here.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { recordServingTurnByRowid } from '../memory/message-store.js';
import {
  isTerminal, revertAskClaimOnAbort, transition, type WorkState,
} from './store.js';

const logger = createLogger('ask-settlement');

/** Tools whose delivery is NOT an answer to the ask that is open.
 *
 *  ⚠ OR2-PROVISIONAL: CLOSED, PHASE-4 T4 (2026-08-02). The marker said T4 would remove the
 *  `engine-ack` lane entirely. It removed the ENGINE'S PROSE from it instead: the lane's one
 *  surviving caller delivers the model's own opening line early, which is the shape OR2
 *  wants. The exclusion stands for the reason it always really had — A START-ACK IS NOT AN
 *  ANSWER — and closing an ask on one would mark a question answered before anybody looked
 *  at it. Kept in step with `agent/v2/answered-edge.ts`'s `NON_ANSWERING_TOOLS`.
 *
 *  Carried here VERBATIM from `work/store.ts` with the closer it belonged to. */
export const NON_ANSWERING_DELIVERY_TOOLS = new Set(['engine-ack']);

/** How far back a boot reconciliation will reach. Carried verbatim from the pickup-stamp
 *  reconciliation it replaced (`index.ts` 4b1): a claim stranded by a genuine crash is
 *  seconds-to-minutes old, and anything older is history a restart must not re-answer. */
export const ORPHAN_CLAIM_WINDOW_MINUTES = 30;

/** Where in the lifecycle the question is being asked. It selects the TIE-BREAK when there
 *  is no evidence — never the evidence itself, which is identical at all three. */
export type SettlementMoment = 'delivery' | 'finalize' | 'boot';

export type AskSettlementVerdict = 'closed' | 'held' | 'reopened' | 'unchanged';

export interface AskSettlementOutcome {
  workId: string;
  verdict: AskSettlementVerdict;
  /** The delivery the close points at, when one was found. */
  deliveryId: string | null;
  /** Why, in one line, for the log and for the caller that wants to say something. */
  detail: string;
}

export interface SettlementContext {
  agentId: string;
  /** The turn whose record is the evidence. */
  turnNumber: number | null;
  at: SettlementMoment;
  /** The ask's own message row, when the caller holds it. A settlement stamps
   *  `messages.served_by_turn` as PART of closing — the fact the teardown batch-claim used
   *  to write on its own, so the "this turn answered this row" record and the "this ask is
   *  closed" record can never disagree. `setAnswerMessageId` keys on exactly this column. */
  rowid?: number | null;
  actorId?: string | null;
}

interface AskRow {
  id: string;
  agent_id: string;
  kind: string;
  state: WorkState;
  conversation_id: string | null;
  opened_at: number;
  root_id: string;
  remaining_children: number | null;
  compile_pending: number;
  claimed_by_turn: number | null;
}

function readAsk(workId: string): AskRow | undefined {
  return getDb().prepare(
    `SELECT id, agent_id, kind, state, conversation_id, opened_at, root_id,
            remaining_children, compile_pending, claimed_by_turn
       FROM work WHERE id = ?`,
  ).get(workId) as AskRow | undefined;
}

/**
 * THE EVIDENCE. One query, asked the same way at all three moments.
 *
 * Four narrowings, each of which is a negative control in `__tests__/ask-settlement.test.ts`:
 *   * the send must have SUCCEEDED (`outcome = 'delivered'`);
 *   * it must belong to the TURN being adjudicated;
 *   * it must have gone to the ask's OWN conversation (an email to a third party sent while
 *     working on the owner's question is not its answer);
 *   * it must POSTDATE the ask's arrival — a delivery recorded before the ask existed cannot
 *     be its answer, which is the shape the fresh probe pair produced and the shape a
 *     remediation keyed only on `answer_message_id` would have mis-read (verify report §5.6).
 * Plus the `engine-ack` exclusion, carried verbatim.
 *
 * THE COMPARISON IS AT THE LEDGER'S OWN RESOLUTION, and that is a decision rather than a
 * rounding accident: `deliveries.created_at` is `datetime('now')`, i.e. whole seconds, while
 * `work.opened_at` is epoch-ms. Comparing at millisecond precision against a column that
 * does not carry milliseconds would manufacture false negatives inside the same second. Both
 * sides are therefore floored to the second; the arm still bites on any delivery recorded in
 * an EARLIER second than the ask arrived, which is what "predates" means on this ledger.
 */
function qualifyingDelivery(
  ask: AskRow, turnNumber: number | null,
): { id: string; tool: string } | null {
  if (turnNumber == null || ask.conversation_id == null) return null;
  const excluded = [...NON_ANSWERING_DELIVERY_TOOLS];
  return (getDb().prepare(
    `SELECT id, tool FROM deliveries
      WHERE agent_id = ? AND turn_number = ? AND conversation_id = ?
        AND outcome = 'delivered'
        AND tool NOT IN (${excluded.map(() => '?').join(', ')})
        AND unixepoch(created_at) >= ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(ask.agent_id, turnNumber, ask.conversation_id, ...excluded, Math.floor(ask.opened_at / 1000)) as
    { id: string; tool: string } | undefined) ?? null;
}

/** Is there delegated work under this ask that has not come back and been compiled yet? */
function joinOutstanding(ask: AskRow): boolean {
  return (ask.remaining_children ?? 0) > 0 || ask.compile_pending === 1;
}

/**
 * THE AUTHORITY. Every transition of a `kind='ask'` row into `done` goes through here, and
 * so does every decision NOT to.
 */
export function settleAsk(workId: string, ctx: SettlementContext): AskSettlementOutcome {
  const actorId = ctx.actorId ?? ctx.agentId;
  const out = (verdict: AskSettlementVerdict, detail: string, deliveryId: string | null = null):
  AskSettlementOutcome => ({ workId, verdict, deliveryId, detail });

  const ask = readAsk(workId);
  if (!ask) return out('unchanged', 'no such work row');
  if (ask.kind !== 'ask') return out('unchanged', `not an ask (kind=${ask.kind})`);
  if (isTerminal(ask.state)) return out('unchanged', `already ${ask.state}`);

  // ── HOLD. The owner asked for something the agent delegated: it is NOT answered because a
  //    turn spoke, and it must stay OWED and visible until the delegated work settles and its
  //    compiled answer actually lands. `blocked` is an existing OWED state — the OPEN WORK
  //    surface renders it, so the model keeps being reminded the job is still owed. ──
  if (joinOutstanding(ask)) {
    if (ask.state === 'blocked') return out('held', 'already held on the delegation');
    const reason = 'held: delegated work is still outstanding '
      + `(${ask.remaining_children ?? 0} child(ren) remaining`
      + `${ask.compile_pending === 1 ? ', compile pending' : ''}) — `
      + 'an ask is not answered because a turn spoke about starting it';
    const r = transition(workId, {
      to: 'blocked', by: 'agent', actorId, expectedState: ask.state, reason,
    });
    if (r.kind !== 'applied') return out('unchanged', `hold refused: ${r.kind}`);
    logger.info('ask held: delegated work outstanding', {
      agentId: ask.agent_id, workId, remaining: ask.remaining_children, compilePending: ask.compile_pending,
    }, ask.agent_id);
    return out('held', reason);
  }

  // ── CLOSE. Something was DELIVERED for it — never because a model said so. ──
  const evidence = qualifyingDelivery(ask, ctx.turnNumber);
  if (evidence) {
    const r = transition(workId, {
      to: 'done', by: 'agent', actorId, resultDeliveryId: evidence.id,
      expectedState: ask.state, reason: `delivered via ${evidence.tool}`,
    });
    if (r.kind !== 'applied') return out('unchanged', `close refused: ${r.kind}`, evidence.id);
    // The serve edge, written as part of the settlement rather than by a second owner.
    if (ctx.rowid != null && ctx.turnNumber != null) {
      recordServingTurnByRowid({ agentId: ask.agent_id, rowid: ctx.rowid, servedByTurn: ctx.turnNumber });
    }
    return out('closed', `delivered via ${evidence.tool}`, evidence.id);
  }

  // ── NO EVIDENCE. ──
  // Mid-turn this means nothing yet: the turn may be about to answer, and re-opening a live
  // claim would race the turn that holds it.
  if (ctx.at === 'delivery') return out('unchanged', 'no qualifying delivery yet; the turn is still live');
  // At boot the second arm below (`reconcileOrphanedClaims`) owns the no-evidence case,
  // because a crashed turn's disposition is P6b's counted question, not this one.
  if (ctx.at === 'boot') return out('unchanged', 'no qualifying delivery; the crash arm decides');
  // At turn finalize the question is settled: this turn is over, nothing was delivered for
  // this ask, and the person is still waiting. It goes back — visible.
  if (ask.state === 'open') return out('unchanged', 'already open and waiting');
  const reason = `re-opened: turn ${ctx.turnNumber ?? '?'} finalized with no delivery that answers this ask — `
    + 'the person is still waiting, so the ask is visible again rather than parked';
  const r = transition(workId, {
    to: 'open', by: 'agent', actorId, expectedState: ask.state, reason,
  });
  if (r.kind !== 'applied') return out('unchanged', `re-open refused: ${r.kind}`);
  logger.info('ask re-opened: its turn finalized without delivering an answer', {
    agentId: ask.agent_id, workId, turnNumber: ctx.turnNumber, from: ask.state,
  }, ask.agent_id);
  return out('reopened', reason);
}

// ════════════════════════════════════════════════════════════════════════════════
// INVOCATION (a) — AT EACH DELIVERY, INSIDE THE DELIVERY TRANSACTION
// ════════════════════════════════════════════════════════════════════════════════

export interface DeliveryCloseInput {
  agentId: string;
  turnNumber: number | null;
  deliveryId: string;
  conversationId: string | null;
  tool: string;
  outcome: string;
}

/**
 * A quick ask is done when something was DELIVERED for it — never because a model said so.
 *
 * This is the shape the solo lifecycle has always had and it is deliberately unchanged:
 * opened -> pickup -> done-with-receipt AT SEND TIME. Moving the close to finalize would have
 * made every quick answer wait for the turn boundary, which is a behaviour change nobody
 * asked for.
 *
 * The arguments narrow the SCOPE (which rows this delivery could possibly answer); the
 * decision is `settleAsk`'s, and it re-reads the ledger row this call just inserted rather
 * than trusting the arguments — one evidence read, in one place, at all three moments.
 */
export function settleAsksForDelivery(p: DeliveryCloseInput): number {
  if (p.outcome !== 'delivered') return 0;
  if (p.turnNumber == null || p.conversationId == null) return 0;
  if (NON_ANSWERING_DELIVERY_TOOLS.has(p.tool)) return 0;
  const rows = getDb().prepare(
    `SELECT id FROM work
      WHERE agent_id = ? AND kind = 'ask' AND state = 'claimed'
        AND claimed_by_turn = ? AND conversation_id = ?`,
  ).all(p.agentId, p.turnNumber, p.conversationId) as Array<{ id: string }>;
  let closed = 0;
  for (const r of rows) {
    const s = settleAsk(r.id, { agentId: p.agentId, turnNumber: p.turnNumber, at: 'delivery' });
    if (s.verdict === 'closed') closed++;
  }
  return closed;
}

// ════════════════════════════════════════════════════════════════════════════════
// INVOCATION (b) — TURN FINALIZE, THE FINAL ADJUDICATOR
// ════════════════════════════════════════════════════════════════════════════════

/** One row of the assembled-context set: the ask, and the message row to stamp when it
 *  settles. Produced by `agent/v2/counterparty.ts:assembledContextAsks`, which READS and
 *  writes nothing — the state change is the authority's alone. */
export interface AssembledAsk { workId: string; rowid: number }

export interface FinalizeSettlementInput {
  agentId: string;
  turnNumber: number;
  /** Every ask that entered this turn's context: the same-conversation rows that were inside
   *  the final assembly. Rows arriving AFTER it are deliberately absent (OPEN-12: a genuinely
   *  newer message gets its own turn) — that exclusion lives in the read, not here. */
  assembled?: AssembledAsk[];
}

export interface FinalizeSettlementResult { closed: number; held: number; reopened: number }

/**
 * The turn is over. Every ask it CLAIMED, and every ask that entered its ASSEMBLED CONTEXT,
 * gets its verdict now: closed with the receipt, held on an unresolved delegation, or handed
 * back open.
 *
 * ── THE STRUCTURAL INVARIANT ── no ask remains `claimed` by a finalized turn. That is the
 * line that makes the fossil class unrepresentable, and `__tests__/ask-done-census.test.ts`
 * PART B is the census that keeps it true.
 *
 * The claimed set is scoped by TURN and not by conversation: an ask this turn picked up and
 * then answered somewhere else is still this turn's to dispose of.
 */
export function settleAsksAtTurnFinalize(p: FinalizeSettlementInput): FinalizeSettlementResult {
  const result: FinalizeSettlementResult = { closed: 0, held: 0, reopened: 0 };
  const claimed = getDb().prepare(
    `SELECT id FROM work
      WHERE agent_id = ? AND kind = 'ask' AND state = 'claimed' AND claimed_by_turn = ?`,
  ).all(p.agentId, p.turnNumber) as Array<{ id: string }>;

  const seen = new Set<string>();
  const tally = (v: AskSettlementVerdict): void => {
    if (v === 'closed') result.closed++;
    else if (v === 'held') result.held++;
    else if (v === 'reopened') result.reopened++;
  };
  for (const r of claimed) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    tally(settleAsk(r.id, { agentId: p.agentId, turnNumber: p.turnNumber, at: 'finalize' }).verdict);
  }
  for (const a of p.assembled ?? []) {
    if (seen.has(a.workId)) continue;
    seen.add(a.workId);
    tally(settleAsk(a.workId, {
      agentId: p.agentId, turnNumber: p.turnNumber, at: 'finalize', rowid: a.rowid,
    }).verdict);
  }
  if (result.closed > 0 || result.held > 0 || result.reopened > 0) {
    logger.info('turn finalize: owner asks adjudicated', {
      agentId: p.agentId, turnNumber: p.turnNumber, ...result, considered: seen.size,
    }, p.agentId);
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════════════════
// INVOCATION (c) — BOOT RECONCILE OF CRASHED TURNS
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Crash test B, the durable half: a process killed between the CLAIM and the EFFECT.
 *
 * The claim is in the database and the turn is not, so on restart the ask reads as being
 * served by a turn that will never finish. Three outcomes and no fourth:
 *   * the dead turn DELIVERED  -> the authority closes it against that delivery (the same
 *     evidence `settleAsksForDelivery` would have used had the process lived one more
 *     statement). Its decision is no longer this function's;
 *   * it recorded ZERO effectful calls -> hand the ask back, the person is served again;
 *   * it recorded some -> HOLD it, because the effect already happened and a second turn
 *     would repeat it (P6b, unchanged: the crash case is the one the counted input exists
 *     for, and the turn boundary — where the owner's 2026-08-05 ruling governs — never ran).
 *
 * Trigger and window are carried verbatim: boot only, ≤30 minutes, dead turns.
 * Relocated from `work/store.ts` with the decision it now shares.
 */
export function reconcileOrphanedClaims(): { reArmed: number; held: number; closed: number } {
  const db = getDb();
  const since = Date.now() - ORPHAN_CLAIM_WINDOW_MINUTES * 60 * 1000;
  const answered = db.prepare(`
    SELECT w.id AS id, w.agent_id AS agent_id, w.claimed_by_turn AS turn_number
      FROM work w
      JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = w.claimed_by_turn
     WHERE w.kind = 'ask' AND w.state = 'claimed' AND w.updated_at >= ?
       AND t.ended_at IS NULL
     GROUP BY w.id
  `).all(since) as Array<{ id: string; agent_id: string; turn_number: number }>;
  let closed = 0;
  for (const a of answered) {
    const s = settleAsk(a.id, {
      agentId: a.agent_id, turnNumber: a.turn_number,
      at: 'boot', actorId: 'boot-reconciliation',
    });
    if (s.verdict === 'closed') closed++;
  }

  const rows = db.prepare(`
    SELECT w.id AS id, COALESCE(t.effectful_calls, 0) AS effectful_calls
      FROM work w
      LEFT JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = w.claimed_by_turn
     WHERE w.kind = 'ask' AND w.state = 'claimed' AND w.updated_at >= ?
       AND (t.turn_number IS NULL OR t.ended_at IS NULL)
  `).all(since) as Array<{ id: string; effectful_calls: number }>;
  let reArmed = 0; let held = 0;
  for (const r of rows) {
    const res = revertAskClaimOnAbort(
      r.id, r.effectful_calls,
      'boot reconciliation: the claiming turn never finished (process killed between claim and effect)',
    );
    if (res === null) held++;
    else if (res.kind === 'applied') reArmed++;
  }
  if (reArmed > 0 || held > 0 || closed > 0) {
    logger.warn('boot reconciliation of orphaned ask claims', { reArmed, held, closed });
  }
  return { reArmed, held, closed };
}
