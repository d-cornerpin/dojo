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
  appendWorkEvent, claimFailedJoinForLateAnswer, isTerminal, revertAskClaimOnAbort, transition,
  type WorkState,
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

/**
 * ⚠ SWEEP-A TB2 — AND NEITHER IS A TOOL-CALL CHIP. The same doctrine, one row deeper.
 *
 * `messages.display_kind = 'tool-turn'` is an assistant row whose CONTENT is the model's
 * `tool_use` blocks; the dashboard renders it as a chip. It is `user-visible` (the person can
 * see that a tool ran) but it is not a REPLY, and the dashboard door records a `deliveries`
 * row for it exactly as it does for prose.
 *
 * MEASURED, not reasoned about — the premature close the kit scenario `delegation-longhorizon`
 * clause (e) reproduced 2 of 2 at `3439240` pointed at a chip on BOTH attempts (read from the
 * live body at TB2 Step 0):
 *
 *   ask:3857ef59  done 10:34:39  receipt 3da6365b -> message a03a5ac9  display_kind=tool-turn
 *   ask:b72e81ad  done 10:40:49  receipt 49c963a2 -> message 98ffe54b  display_kind=tool-turn
 *
 * …and on both attempts the model's real prose reply landed AFTER the delegation join opened,
 * so with the chip excluded the HOLD arm below fires on the real reply and the ask is never
 * terminal at all. That is why this is a NARROWING of the evidence rather than a re-open at
 * the turn boundary: the record is read as HISTORY, and a `done` that is later undone is
 * still a job that was marked finished before it happened.
 *
 * The exclusion is keyed on the delivery's OWN message row, so a channel send that records no
 * message id (email, iMessage, SMS) is untouched — it is excluded only when the row it
 * carried is provably a chip.
 */
export const NON_ANSWERING_DISPLAY_KINDS = ['tool-turn'] as const;

/** How far back a boot reconciliation will reach. Carried verbatim from the pickup-stamp
 *  reconciliation it replaced (`index.ts` 4b1): a claim stranded by a genuine crash is
 *  seconds-to-minutes old, and anything older is history a restart must not re-answer. */
export const ORPHAN_CLAIM_WINDOW_MINUTES = 30;

/** Where in the lifecycle the question is being asked. It selects the TIE-BREAK when there
 *  is no evidence — never the evidence itself, which is identical at all three.
 *
 *  `join` (SWEEP-A TB2) is the fourth, and it is the one moment whose EVIDENCE differs, for a
 *  stated reason: a compiled answer to a delegated job arrives on a LATER turn than the one
 *  that opened the join, so "this turn's delivery" cannot be the test. What replaces it is
 *  strictly narrower, never wider — the delivery must postdate the join's own `join_complete`
 *  event, so nothing the delegating turn said about STARTING the work can ever be read as the
 *  answer to it. */
export type SettlementMoment = 'delivery' | 'finalize' | 'boot' | 'join';

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
  /** JOIN MOMENT ONLY: the delivery the relay just recorded, when the caller holds one. It is
   *  still CHECKED here (delivered, this agent, not a chip, postdating `join_complete`) — the
   *  caller narrows the scope, the authority decides. */
  deliveryId?: string | null;
  /** JOIN MOMENT ONLY: the sentence recorded on the transition. */
  reason?: string;
  /** JOIN MOMENT ONLY: WHICH join fact this settlement is made of. It selects the boundary
   *  the delivery must postdate and nothing else — the evidence read is one query either way.
   *   * `compiled`    — the countdown reached zero and the combined answer went out. The
   *                     children must ALL have settled and the delivery must postdate the
   *                     row's own `join_complete`. This is the arm bug 2 is about.
   *   * `late-answer` — the join already FAILED CLOSED (the owner has been told no answer was
   *                     coming) and a real answer arrived afterwards. There is no completed
   *                     countdown to postdate — that is the whole situation — so the boundary
   *                     is the ask's own arrival, exactly as the delivery arm uses it.
   *                     requirement preserved (PHASE-2 AUDIT-FIX): a late answer still reaches
   *                     the owner, ONCE, and the exactly-once guard is the `failed -> open`
   *                     transition that precedes this call. */
  basis?: 'compiled' | 'late-answer';
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
  result_delivery_id: string | null;
}

function readAsk(workId: string): AskRow | undefined {
  return getDb().prepare(
    `SELECT id, agent_id, kind, state, conversation_id, opened_at, root_id,
            remaining_children, compile_pending, claimed_by_turn, result_delivery_id
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
    `SELECT d.id AS id, d.tool AS tool FROM deliveries d
      WHERE d.agent_id = ? AND d.turn_number = ? AND d.conversation_id = ?
        AND d.outcome = 'delivered'
        AND d.tool NOT IN (${excluded.map(() => '?').join(', ')})
        AND ${NOT_A_TOOL_CHIP}
        AND unixepoch(d.created_at) >= ?
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
  ).get(ask.agent_id, turnNumber, ask.conversation_id, ...excluded, Math.floor(ask.opened_at / 1000)) as
    { id: string; tool: string } | undefined) ?? null;
}

/**
 * THE SAME EVIDENCE READ, EXPOSED — SWEEP-A TB3.
 *
 * The remediation pass has to know whether an ask was answered before it can dispose of a row
 * that is already TERMINAL (`abandoned`, or `done` on a receipt that turns out to be a chip),
 * and `settleAsk` refuses terminal rows by design. Rather than let the pass re-state the rule
 * — a second decider, which is the disease this arc exists to cure — the authority's OWN
 * predicate is exported and the pass asks it.
 *
 * It is a READ. It decides nothing and writes nothing: the state change still goes through
 * `settleAsk`, and the pass supplies only SCOPE (which row, which turn). DESIGN §5 states the
 * requirement in the same words — *"the split uses the same evidence predicate as the
 * authority itself, so remediation and forward behaviour cannot disagree."*
 */
export function askAnswerEvidence(
  workId: string, turnNumber: number | null,
): { id: string; tool: string } | null {
  const ask = readAsk(workId);
  if (!ask || ask.kind !== 'ask') return null;
  return qualifyingDelivery(ask, turnNumber);
}

/** The fifth narrowing, as a SQL fragment so the delivery arm and the join arm cannot drift
 *  apart. Literal by construction (the list is a frozen tuple of lowercase identifiers), so
 *  the statement still prepares under the schema-conformance walk. */
const NOT_A_TOOL_CHIP =
  `NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = d.message_id AND m.display_kind IN (${
    NON_ANSWERING_DISPLAY_KINDS.map((k) => `'${k}'`).join(', ')}))`;

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

  // ── THE ORDERING ARM (SWEEP-A TB2). A turn that ANSWERED and then DELEGATED. ──
  //
  // The chip narrowing above kills the premature close whenever the model delegates before it
  // speaks — the join is open by the time the real reply lands, so the hold arm fires and the
  // row is never terminal. It cannot help the other ordering. MEASURED, run `bmsg2ufve1q`
  // `ask:b66cbb75`: the model wrote a genuine prose status line at +19 s and only issued its
  // `send_to_agent` calls at +40 s, so at the instant of the close there was no delegated work
  // in existence and no evidence any was coming.
  //
  // At the TURN BOUNDARY there is. The join is on the row, and the ticket says `done` on a
  // delivery that answered nothing — the exact state every safety net downstream is blind to.
  // So the boundary hands it back: two recorded moves, `done -> open` (the only legal exit
  // from `done`, and it needs the engine actor pointing at the receipt it is undoing) and then
  // the ordinary HOLD. The person's ask is OWED again and the ladder can drive it.
  //
  // ⚠ WHAT THIS DOES NOT DO, stated rather than left to be discovered: the `done` transition
  // already happened and stays in the history. A judge that reads the event log will still see
  // it. The row is honest from the turn boundary onward, not retroactively — undoing the
  // RECORD would be the forgery this spine exists to refuse.
  //
  // ⚠ SWEEP-A TB3 — AND AT BOOT, FOR THE SAME SHAPE THE SAME TURN LEFT BEHIND. Finalize is
  // where this arm belongs, and a process killed between the delegation and the finalize
  // never reaches it: the row survives the crash `done` with its join unresolved, which is
  // bug 2's own state with nobody left to correct it. The boot reconciler already exists for
  // turns that died mid-lifecycle and already carries the bound — thirty minutes, dead turn —
  // so the crash window is that arm's scope widened by one shape, never a second mechanism.
  if (ask.state === 'done' && (ctx.at === 'finalize' || ctx.at === 'boot') && joinOutstanding(ask)) {
    // ⚠ SWEEP-A TB6 — AND IT DROPS THE RECEIPT IT IS UNDOING. `evidenceRef` names the
    // delivery so the undo can be audited (and G6 requires the engine to point at something);
    // `clearResultDelivery` takes the row off it. Those are two different jobs: the event is
    // the RECORD of what was undone and stays, the column is CURRENT STATE — "the delivery
    // this row is settled on" — and a row that has just been handed back is settled on
    // nothing. Without the clear the row went back to `open`/`blocked` still pointing at a
    // superseded receipt (TB5 §Q5, `ask:fa74a65f`: 4 m 55 s of it, and the correct settlement
    // landed 114 s after the window). Two readers were measurably wrong for that whole time:
    // the kit's (e2) clause read the stale pointer as the ask's receipt, and
    // `owedSendObligations` — the claimed-delivery floor's "is this person still owed an
    // answer" query — EXCLUDED the row, because it filters `result_delivery_id IS NULL` on the
    // belief (stated in its own comment) that a non-`done` row cannot carry one. It can, and
    // this was how.
    const undo = transition(workId, {
      to: 'open', by: 'engine', actorId: 'ask-settlement', expectedState: 'done',
      evidenceRef: ask.result_delivery_id ?? undefined,
      clearResultDelivery: true,
      reason: 'handed back: this turn closed the ask and THEN delegated the work under it — '
        + 'the delivery it closed on answered nothing, and the delegated pieces are still out',
    });
    if (undo.kind === 'applied') {
      logger.warn('ask handed back at the turn boundary: it was closed and then delegated under', {
        agentId: ask.agent_id, workId, remaining: ask.remaining_children,
        compilePending: ask.compile_pending, turnNumber: ctx.turnNumber,
      }, ask.agent_id);
      const held = settleAsk(workId, ctx);
      return held.verdict === 'unchanged'
        ? out('reopened', 'handed back after a close-then-delegate turn')
        : held;
    }
  }

  if (isTerminal(ask.state)) return out('unchanged', `already ${ask.state}`);

  // ── THE JOIN ARM (SWEEP-A TB2). The delegated job's own settlement, on the same rule. ──
  //    It is ABOVE the hold arm deliberately: at this moment `compile_pending` is still 1 —
  //    it is `transition()` that clears it on a terminal move — so a hold tested first would
  //    hold the very row whose answer has just landed, for ever.
  if (ctx.at === 'join') return settleOnJoin(ask, ctx, actorId, out);

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
// THE JOIN ARM — SWEEP-A TB2, folding `settleJoinDelivered` in (DESIGN §1b, row 5)
//
// requirement preserved: *"close the join-ask when the compiled result is actually delivered
// — already evidence-backed"*, and `compile_resolved` is finally written on it. What the old
// function could not do is refuse: it took whatever delivery id the relay handed it and moved
// the row, so the delegating turn's own status line was an acceptable receipt. The rule here
// is the authority's, stated once and not weakened:
//
//   * the CHILDREN must actually have settled — `remaining_children = 0`, no exception. This
//     is the "settled is not widened" refusal in code: a job with a piece still out is not a
//     job whose answer can be pointed at.
//   * the DELIVERY must actually have landed AFTER the join completed. `join_complete` is the
//     row's own event, written inside the same transaction as the decrement that reached zero,
//     so it is the honest boundary between "talking about starting it" and "answering it".
//   * and it must be an answer at all — delivered, this agent's, not a tool-call chip, not an
//     `engine-ack`.
//
// WHAT THIS REPLACED, AND WHY THE REPLACEMENT IS STRICTLY NARROWER. The compile driver used
// to ask `answerReceiptForAsk(join.rootId)` — "does the ask record an answer?" — which is TRUE
// the moment `messages.answer_message_id` is stamped at the delegating turn's finalize. On
// every recorded red run that was true within seconds of the delegation, so the driver
// cleared `compile_pending` and the compile was never driven. That is the same status-line
// error one layer up, and it is why `compile_resolved` had been written 0 times ever.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * THE TURN THAT DELEGATED, from the row's own `claim_turn` event. `null` when the ask was
 * never claimed (the B3 shape), in which case this narrowing simply does not apply.
 *
 * ⚠ WHY THE COMPILED ANSWER MUST COME FROM A LATER TURN, and it is a MEASUREMENT, not a
 * theory. Run `bmsg278e0k2`, `ask:de4b50c5` (2026-08-05 12:25): the tool-chip narrowing worked
 * and the hold fired on the status line at 12:25:36 — but the two toy workers came back one
 * second later (12:25:37), and the delegating turn's SECOND status line at 12:25:40 postdated
 * `join_complete`, so the join arm read *"I'll compile the final report once they're back"* as
 * the compiled report and closed the ask. The timing clause passed and the system stopped
 * driving — which is Bug 2 wearing a slightly later hat.
 *
 * A turn cannot compile an answer out of pieces that had not come back when it started. The
 * delegation exit ENDS the turn that opened the join (`steps/execute/delegation-exit.ts`), so
 * the compile is always a later turn's work; and the engine's own relay records
 * `turn_number = NULL` (verified on delivery `42559251`), which is why NULL qualifies.
 */
function delegatingTurn(workId: string): number | null {
  const r = getDb().prepare(
    `SELECT json_extract(payload, '$.turn_number') AS t FROM work_events
      WHERE work_id = ? AND kind = 'claim_turn' ORDER BY id DESC LIMIT 1`,
  ).get(workId) as { t: number | null } | undefined;
  return r?.t ?? null;
}

/** When the join's countdown reached zero, from the row's own event. `null` when it never
 *  did — in which case there is no compiled anything and nothing can qualify. */
function joinCompletedAt(workId: string): number | null {
  const r = getDb().prepare(
    `SELECT MAX(created_at) AS at FROM work_events WHERE work_id = ? AND kind = 'join_complete'`,
  ).get(workId) as { at: number | null } | undefined;
  return r?.at ?? null;
}

/** The compiled answer's receipt, or null. One statement, whether the caller named a delivery
 *  or not — a named one is CHECKED against the same predicate, never trusted. */
function compiledDelivery(
  ask: AskRow, completedAtMs: number, named: string | null | undefined, afterTurn: number | null,
): { id: string; tool: string } | null {
  const db = getDb();
  const excluded = [...NON_ANSWERING_DELIVERY_TOOLS];
  const floorSec = Math.floor(completedAtMs / 1000);
  // The delegating turn's own bubbles are not the compiled answer. NULL qualifies: the engine
  // relay records no turn, and it IS a compiled delivery.
  const laterTurn = afterTurn == null ? '' : 'AND (d.turn_number IS NULL OR d.turn_number > @afterTurn)';
  const bind = (extra: Record<string, unknown>): Record<string, unknown> => {
    const o: Record<string, unknown> = { agentId: ask.agent_id, floorSec, ...extra };
    excluded.forEach((t, i) => { o[`x${i}`] = t; });
    if (afterTurn != null) o.afterTurn = afterTurn;
    return o;
  };
  const excludedSql = excluded.map((_, i) => `@x${i}`).join(', ');
  if (named) {
    return (db.prepare(
      `SELECT d.id AS id, d.tool AS tool FROM deliveries d
        WHERE d.id = @named AND d.agent_id = @agentId AND d.outcome = 'delivered'
          AND d.tool NOT IN (${excludedSql})
          AND ${NOT_A_TOOL_CHIP}
          AND unixepoch(d.created_at) >= @floorSec
          ${laterTurn}`,
    ).get(bind({ named })) as { id: string; tool: string } | undefined) ?? null;
  }
  if (ask.conversation_id == null) return null;
  return (db.prepare(
    `SELECT d.id AS id, d.tool AS tool FROM deliveries d
      WHERE d.agent_id = @agentId AND d.conversation_id = @conv AND d.outcome = 'delivered'
        AND d.tool NOT IN (${excludedSql})
        AND ${NOT_A_TOOL_CHIP}
        AND unixepoch(d.created_at) >= @floorSec
        ${laterTurn}
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
  ).get(bind({ conv: ask.conversation_id })) as
    { id: string; tool: string } | undefined) ?? null;
}

function settleOnJoin(
  ask: AskRow,
  ctx: SettlementContext,
  actorId: string,
  out: (v: AskSettlementVerdict, detail: string, deliveryId?: string | null) => AskSettlementOutcome,
): AskSettlementOutcome {
  const basis = ctx.basis ?? 'compiled';
  let boundaryMs: number;
  if (basis === 'compiled') {
    if ((ask.remaining_children ?? -1) !== 0) {
      return out('unchanged',
        `the children have not all settled (${ask.remaining_children ?? 'no join'} outstanding)`);
    }
    const completedAt = joinCompletedAt(ask.id);
    if (completedAt == null) return out('unchanged', 'the join never recorded a completion');
    boundaryMs = completedAt;
  } else {
    boundaryMs = ask.opened_at;
  }
  // The late-answer arm has no delegating-turn constraint: its whole situation is that the
  // countdown never completed and an answer arrived out of band, on whatever turn carried it.
  const evidence = compiledDelivery(
    ask, boundaryMs, ctx.deliveryId, basis === 'compiled' ? delegatingTurn(ask.id) : null,
  );
  if (!evidence) {
    return out('unchanged', basis === 'compiled'
      ? 'the compiled answer has not landed for the owner yet'
      : 'the late answer produced no delivery that can be pointed at');
  }
  const reason = ctx.reason ?? 'the compiled answer reached the owner';
  const r = transition(ask.id, {
    to: 'done', by: 'engine', actorId, reason,
    evidenceRef: evidence.id, resultDeliveryId: evidence.id,
  });
  if (r.kind !== 'applied') return out('unchanged', `join close refused: ${r.kind}`, evidence.id);
  // The fact `compile_pending` existed to record, finally written on a real completion. The
  // flag itself is cleared by `transition()`'s terminal arm, so this event is the HISTORY of
  // the resolution rather than a second owner of the column.
  appendWorkEvent(ask.id, 'compile_resolved', actorId, {
    reason, basis, delivery_id: evidence.id, tool: evidence.tool, boundary_at: boundaryMs,
  });
  logger.info('join settled: the compiled answer reached the owner', {
    agentId: ask.agent_id, workId: ask.id, deliveryId: evidence.id, tool: evidence.tool,
  }, ask.agent_id);
  return out('closed', reason, evidence.id);
}

/**
 * INVOCATION (d) — THE JOIN RELAY. Scope only; the decision is `settleAsk`'s.
 *
 * `deliveryId` is what the caller just recorded, when it holds one; omit it and the authority
 * looks for the compiled answer itself, which is what the turn-end compile drain needs (the
 * MODEL delivered it, so no relay holds an id).
 */
export function settleAskOnJoin(
  parentWorkId: string,
  p: {
    agentId?: string; deliveryId?: string | null; reason: string; actorId?: string | null;
    basis?: 'compiled' | 'late-answer';
  },
): AskSettlementOutcome {
  // `agentId` is SCOPE the join arm does not need — it reads the agent off the row it is
  // about — so it is optional here and the actor defaults to the relay's own name.
  return settleAsk(parentWorkId, {
    agentId: p.agentId ?? 'a2a-join', turnNumber: null, at: 'join',
    deliveryId: p.deliveryId ?? null, reason: p.reason, basis: p.basis,
    actorId: p.actorId ?? 'a2a-join',
  });
}

/**
 * An answer arrived AFTER the join failed closed. It still reaches the owner, once.
 *
 * RELOCATED from `work/store.ts` with the settle it composes (SWEEP-A TB2). Two recorded moves
 * rather than one silent overwrite: `failed -> open` (the join is live again) then the
 * authority's join close against the delivery that carried the update. The transport performs
 * exactly these two calls with the send in between, unchanged.
 *
 * requirement preserved: the exactly-once guard is the `failed -> open` transition — one
 * caller wins it, everyone else gets `conflict`, and that is what stops the owner being told
 * twice. `claimFailedJoinForLateAnswer` still owns that half and is untouched.
 */
export function reopenJoinForLateAnswer(
  parentWorkId: string, deliveryId: string, reason: string,
): AskSettlementOutcome | { kind: 'refused'; reason: string } {
  const reopened = claimFailedJoinForLateAnswer(parentWorkId, deliveryId, reason);
  if (reopened.kind !== 'applied') {
    return { kind: 'refused', reason: reopened.kind === 'no_change' ? 'already-in-state' : reopened.reason };
  }
  return settleAskOnJoin(parentWorkId, { deliveryId, reason, basis: 'late-answer' });
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
  const db = getDb();
  const claimed = db.prepare(
    `SELECT id FROM work
      WHERE agent_id = ? AND kind = 'ask' AND state = 'claimed' AND claimed_by_turn = ?`,
  ).all(p.agentId, p.turnNumber) as Array<{ id: string }>;
  // SWEEP-A TB2 — the third scope: an ask THIS TURN CLOSED that now carries a delegation.
  // `claimed_by_turn` is nulled by the close, so the turn is re-identified through the receipt
  // the close points at. Narrow by construction: it can only ever match a row this turn's own
  // delivery closed, and only while delegated work under it is outstanding.
  const closedThenDelegated = db.prepare(
    `SELECT w.id AS id FROM work w
      WHERE w.agent_id = ? AND w.kind = 'ask' AND w.state = 'done'
        AND (w.remaining_children > 0 OR w.compile_pending = 1)
        AND w.result_delivery_id IN (
          -- the outcome filter is redundant here (the receipt on the row can only ever have
          -- come from a delivered row) and it is written anyway: the enumeration guard in
          -- owner-close-receipt.test.ts requires EVERY production reader of this table to
          -- carry it, and a reader that is safe by argument rather than by predicate is the
          -- shape that guard exists to refuse.
          SELECT d.id FROM deliveries d
           WHERE d.agent_id = ? AND d.turn_number = ? AND d.outcome = 'delivered')`,
  ).all(p.agentId, p.agentId, p.turnNumber) as Array<{ id: string }>;

  const seen = new Set<string>();
  const tally = (v: AskSettlementVerdict): void => {
    if (v === 'closed') result.closed++;
    else if (v === 'held') result.held++;
    else if (v === 'reopened') result.reopened++;
  };
  for (const r of [...claimed, ...closedThenDelegated]) {
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
 *
 * ── SWEEP-A TB3: THE CRASH WINDOW, THE FOURTH OUTCOME ──
 * A turn that CLOSED an ask and then DELEGATED under it is handed back at its own boundary
 * (TB2's ordering arm). A turn killed between those two moments never reaches its boundary,
 * so the row survives the crash `done` with an unresolved join — the exact state every safety
 * net downstream is blind to, and the state bug 2 was about. Same trigger, same window, same
 * dead-turn predicate; only the scope is one shape wider, and the row leaves `done` on the
 * first look so it can never be adjudicated twice.
 */
export function reconcileOrphanedClaims():
{ reArmed: number; held: number; closed: number; handedBack: number } {
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
  // ── THE CRASH WINDOW (SWEEP-A TB3) ──
  // `claimed_by_turn` was NULLed by the close, so the serving turn is re-identified through
  // the receipt the close points at — the same re-identification `settleAsksAtTurnFinalize`
  // performs for the same shape, written the same way on purpose.
  const crashed = db.prepare(`
    SELECT w.id AS id, w.agent_id AS agent_id, d.turn_number AS turn_number
      FROM work w
      JOIN deliveries d ON d.id = w.result_delivery_id AND d.agent_id = w.agent_id
                       AND d.outcome = 'delivered'
      JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = d.turn_number
     WHERE w.kind = 'ask' AND w.state = 'done'
       AND (w.remaining_children > 0 OR w.compile_pending = 1)
       AND w.updated_at >= ?
       AND t.ended_at IS NULL
     GROUP BY w.id
  `).all(since) as Array<{ id: string; agent_id: string; turn_number: number | null }>;
  let handedBack = 0;
  for (const c of crashed) {
    const s = settleAsk(c.id, {
      agentId: c.agent_id, turnNumber: c.turn_number,
      at: 'boot', actorId: 'boot-reconciliation',
    });
    if (s.verdict === 'held' || s.verdict === 'reopened') handedBack++;
  }

  if (reArmed > 0 || held > 0 || closed > 0 || handedBack > 0) {
    logger.warn('boot reconciliation of orphaned ask claims', { reArmed, held, closed, handedBack });
  }
  return { reArmed, held, closed, handedBack };
}
