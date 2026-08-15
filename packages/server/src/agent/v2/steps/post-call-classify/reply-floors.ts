// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE FIVE FLOORS THAT READ THE REPLY ITSELF, moved
// byte-faithfully out of `loop.ts`'s `postCallClassify` span:
//   • the CLAIMED-DELIVERY floor (OPEN-14, rekeyed PHASE-4 T4) — a terminal reply
//     that says it already sent something to a named third party when the LEDGER
//     says otherwise;
//   • the RC-12 DENIAL direction — the inverse guard, for a reply that denies a
//     delivery the ledger recorded;
//   • the RC-13.2 FAILED-SAVE-CLAIM floor — "saved that for you" when every
//     `vault_remember` this turn was rejected. It is the guard CUT 8's Step 1a
//     found with no test anywhere in either repo, and its clauses landed GREEN on
//     the unmoved tree before this file existed;
//   • the DELIVERABLE-CLAIM floor's tombstone, kept because a removal that cannot
//     say why comes back;
//   • the DUPLICATE-FINAL-ANSWER prevention (v2.7.2, scoped down v2.7.3).
//
// THREE OF THE SEVENTEEN `continue` CONVERSIONS ARE HERE. Every one of them is a
// floor asking for one more round so the model can put something right, which is
// exactly what `continueLoop` means: abandon the rest of THIS iteration, let the
// loop head decide whether to run another.
// ════════════════════════════════════════

import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { advance, type AgentTurnState } from '../../state.js';
import { steerFired, steerPriority, type SteerFloorId } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { channelLabel, findRecentDeliveries, findRecentDeliveriesKeyed, relativeTimeAgo } from '../../outbound-ledger.js';
import { isNearDuplicateText } from '../../classifiers/loop.js';
import { detectDeliveryDenial } from '../../classifiers/grounding.js';
import { claimedDeliverySteer, decideClaimedDelivery } from '../../claimed-delivery.js';
import {
  decideUncommittedPromise, openedBoardWorkSince, uncommittedPromiseSteer,
} from '../../recorded-commitment.js';
import { tsToMs } from '../../../../work/tracker-view.js';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

// ════════════════════════════════════════════════════════════════════════════════════════
// HL4 STEP 2 (2e), MERGER 2 — THE FOUR TRUTH GUARDS, DECLARED.
//
// They ask one question with four nouns: *the reply asserts X, and the ledger says not-X.*
// The blocks below still each carry their own copy of the shared prologue; this declaration
// is the set the merger's loop consumes, and it is ORDERED BY THE TABLE rather than by the
// order somebody typed — the same authority 2a made the turn-ending family derive from, so
// the truth band's 10 → 11 → 12 → 13 cannot drift from the argument that ranks it.
// ════════════════════════════════════════════════════════════════════════════════════════

/** One truth guard: the floor it speaks as. */
export interface TruthGuard {
  readonly floor: SteerFloorId;
}

export const TRUTH_GUARDS: readonly TruthGuard[] = Object.freeze(([
  { floor: 'ungrounded-claim' },
  { floor: 'delivery-denial' },
  { floor: 'failed-save-claim' },
  { floor: 'uncommitted-promise' },
] as TruthGuard[]).sort((a, b) => steerPriority(a.floor) - steerPriority(b.floor)));

/** The floors that read the reply's own words against the ledger. */
export function runReplyFloors(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): StepOutcome {
  const { agentId, counterparty, db, result, triggerRow, turnNumber, turnStartedAt } = ctx;
  const { deliberateSurfaceTurn, interAgentTurn } = sc;
  let { persistedContent } = sc;
  // ── Claimed-delivery floor (OPEN-14, REKEYED PHASE-4 T4) ── Catch a fabricated
  // completion BEFORE it is persisted: a terminal, user-facing reply that claims it
  // already delivered something to a NAMED THIRD PARTY when the LEDGER says otherwise.
  //
  // ⚠ THE TRIGGER IS NO LONGER THE PROSE, and the owner is why. On 2026-08-01 this floor
  // fired three times on the words "told Michael" quoted out of a wedding transcript he
  // had asked about, each fire ordering "do it NOW" — double answers, a re-done delivery,
  // and a false accusation made by a regex. `agent/v2/claimed-delivery.ts` is the rekey:
  // the prose only NARROWS (which party does the reply name), and the FIRING is a row —
  // an owed obligation with no delivery against it, or a delivery this turn whose own
  // recorded outcome contradicts the claim. Receipt-keyed, never prose-keyed (research 21).
  //
  // This is not suppression: nothing is hidden, the steer re-enters so the agent either
  // ACTUALLY sends or says so plainly. One steer per ROW (the queue entry's latch key is
  // the obligation / delivery id), so the same claim cannot be hammered.
  if (
    persistedContent &&
    result.toolCalls.length === 0 &&
    !interAgentTurn
  ) {
    const claim = decideClaimedDelivery({
      agentId,
      turnNumber,
      responseText: persistedContent,
      // C5: the CUMULATIVE tool activity across all iterations, not state.toolCalls
      // (overwritten each iteration → always [] on this tool-less terminal iteration, so
      // a real send made earlier in the turn was invisible and the guard false-fired into
      // a DUPLICATE send). Errored calls are excluded here on purpose — a send the tool
      // itself refused is not a delivery, and ARM B's ledger read is what judges the ones
      // that ran and failed at the door.
      toolCallsThisTurn: state.toolResults
        .filter((r) => !r.isError)
        .map((r) => ({ name: r.name })),
      counterpartyName: counterparty.name,
      // RC-12's durable suppressor, unchanged in meaning: a REAL send to the claimed
      // recipient (this turn or within 24h) grounds the claim, so the floor never fires
      // into a duplicate send. P6b-2 keyed consult first, receipts-alias as the legacy
      // prong while pre-121 history ages out.
      hasDeliveryReceipt: (recipient) =>
        findRecentDeliveriesKeyed(agentId, recipient, 24).length > 0 ||
        findRecentDeliveries(agentId, recipient, 24).length > 0,
    });
    if (!claim.fires && claim.recipient) {
      logger.info('v2 claimed-delivery floor stood down; the ledger answered', {
        agentId, recipient: claim.recipient, reason: claim.reason,
      }, agentId);
    }
    if (claim.fires && !steerFired(state.steerQueue, 'ungrounded-claim', claim.latchKey)) {
      // RC-19: deliver the correction via persistEngineSteer so it reaches the
      // model (the steer queue) AND keeps the dashboard row. A bare role='system'
      // row is stripped by the assembler, so pre-fix the agent re-entered without
      // ever seeing the correction and re-posted the same false claim.
      state = persistEngineSteer(
        state,
        {
          agentId, content: claimedDeliverySteer(claim), turnNumber,
          floor: 'ungrounded-claim', atLoop: state.loopCount, key: claim.latchKey,
        },
        { broadcast },
      );
      logger.info('v2 claimed-delivery floor fired on a LEDGER row, re-entering', {
        agentId, recipient: claim.recipient, basis: claim.basis,
        obligationId: claim.obligation?.id ?? null, failedDeliveryId: claim.failedDeliveryId,
      }, agentId);
      return continueLoop(state); // re-enter so the agent actually sends or corrects the claim
    }
  }

  // ── Boundary wrap-up (2026-07-22, consolidated) ── The duplicate
  // wrap-up steer that briefly lived here is GONE: the going-idle nudge
  // below is the one boundary mechanism (4-option menu on SILENT task-work
  // stops; never a re-prompt when a reply exists, the v3.1.10 double-reply
  // rule). For answered turns, the ticket STAMPS land at finalize and the
  // tangible-gated ladder close-steer / strike-2 close the loop within one
  // poke cycle; stacking a second steer here chained re-entries and ate
  // final replies (battery catch).
  // ── RC-12 DENIAL direction ── The inverse of the positive guard: the terminal
  // reply DENIES a delivery ("Not yet", "sending now", "haven't sent it") that the
  // engine receipt ledger proves already happened (F-5, F-22). The denial text
  // detection is deliberately generous; the durable receipt is the true gate, so a
  // steer only fires when a real send is on record. Steer with the receipt fact and
  // re-enter once so the agent answers truthfully AND does not re-send.
  if (
    persistedContent &&
    result.toolCalls.length === 0 &&
    !interAgentTurn &&
    !steerFired(state.steerQueue, 'delivery-denial')
  ) {
    const denial = detectDeliveryDenial({ responseText: persistedContent });
    if (denial.denied) {
      // Named recipient → 24h window (a specific past send); bare "not yet" → a
      // short 1h window so an unrelated older send cannot spuriously ground it.
      // P6b-2: keyed consult first, legacy alias prong second.
      const keyedMatches = denial.recipient
        ? findRecentDeliveriesKeyed(agentId, denial.recipient, 24)
        : findRecentDeliveriesKeyed(agentId, null, 1);
      const matches = keyedMatches.length > 0
        ? keyedMatches
        : denial.recipient
          ? findRecentDeliveries(agentId, denial.recipient, 24)
          : findRecentDeliveries(agentId, null, 1);
      const receipt = matches[0];
      if (receipt) {
        const who = receipt.recipient ?? denial.recipient ?? 'them';
        const nudgeText =
          `[Engine receipt: you DID send ${channelLabel(receipt.channel)} to ${who} ${relativeTimeAgo(receipt.createdAt)}. ` +
          `Answer truthfully; do not re-send.]`;
        state = persistEngineSteer(
          state,
          { agentId, content: nudgeText, turnNumber, floor: 'delivery-denial', atLoop: state.loopCount },
          { broadcast },
        );
        logger.info('v2 delivery-denial guard fired, receipt contradicts denial, re-entering', {
          agentId, recipient: who, channel: receipt.channel,
        }, agentId);
        return continueLoop(state); // re-enter so the agent corrects the denial instead of re-sending
      }
    }
  }

  // ── RC-13.2 failed-save-claim floor ── The reply claims something was saved /
  // stored / remembered, but every vault_remember THIS turn was REJECTED (isError,
  // the RC-13 bounce fix) and nothing was stored. On the floor model, F-6's false
  // "Saved." was the INSTRUCTED behavior (the bookkeeping nudge stapled "reply
  // 'Saved.'" onto a rejection). Steer truthfully once so a rejected save can never
  // masquerade as done.
  if (
    persistedContent &&
    result.toolCalls.length === 0 &&
    !interAgentTurn &&
    !steerFired(state.steerQueue, 'failed-save-claim') &&
    /\b(saved|stored|remembered|noted it|added (it|that) to (memory|the vault)|put it in (memory|the vault))\b/i.test(persistedContent)
  ) {
    const vaultRemembers = state.toolResults.filter((r) => r.name === 'vault_remember');
    const rejected = vaultRemembers.filter((r) => r.isError).length;
    const succeeded = vaultRemembers.filter((r) => !r.isError).length;
    if (succeeded === 0 && rejected >= 1) {
      const nudgeText =
        `You told the user you saved that, but all ${rejected} vault_remember call${rejected === 1 ? '' : 's'} this turn ` +
        `${rejected === 1 ? 'was' : 'were'} REJECTED and nothing was stored. Either retry with the correction the tool ` +
        `gave you, or tell the counterpart truthfully that it is not saved yet. Do not claim it was saved.`;
      state = persistEngineSteer(
        state,
        { agentId, content: nudgeText, turnNumber, floor: 'failed-save-claim', atLoop: state.loopCount },
        { broadcast },
      );
      logger.info('v2 RC-13.2 save-claim floor fired, all vault saves rejected this turn, re-entering', {
        agentId, rejected,
      }, agentId);
      return continueLoop(state); // re-enter so the agent retries the save or tells the truth
    }
  }

  // ── PHASE-6 T-PROMISE: the UNCOMMITTED-PROMISE floor ── The reply tells the person
  // the commitment is recorded, and the work ledger has nothing from this turn. It is the
  // same guard as the three above it with the noun changed from a SEND to a PROMISE, which
  // is what the kit scenario's own `knownFailing` and `task-T0C-report.md` §7 hand-up 4
  // both asked for in writing and neither had an owner for.
  //
  // Why it is here and not a prompt edit: measured at `b17b39b`, the scenario's turn-1
  // shape driven 12 times on the floor model opened a row on 3 — and NINE OF THE NINE
  // MISSES CALLED NO TOOL AT ALL while telling the user it was recorded. There is no verb
  // to consolidate when no verb was called; the only place the failure is visible is right
  // here, after the model has spoken and before the turn ends.
  //
  // Receipt-keyed like its three siblings: `agent/v2/recorded-commitment.ts` holds the
  // decision, the prose only NARROWS (the hit and the miss are the same sentence — proven
  // by a clause), and the spine read is what fires. One steer per turn; across turns the
  // ledger is the latch, because the moment the row exists the floor cannot fire again.
  if (
    persistedContent &&
    result.toolCalls.length === 0 &&
    !interAgentTurn &&
    counterparty.kind === 'user' &&
    !steerFired(state.steerQueue, 'uncommitted-promise')
  ) {
    const turnStartedAtMs = tsToMs(turnStartedAt) ?? 0;
    const promise = decideUncommittedPromise({
      agentId,
      responseText: persistedContent,
      // C5's rule, the same one the claimed-delivery floor states: the CUMULATIVE tool
      // activity across every iteration. `result.toolCalls` is empty by the guard above.
      toolResultsThisTurn: state.toolResults,
      openedWorkThisTurn: () => openedBoardWorkSince(agentId, turnStartedAtMs),
    });
    if (!promise.fires) {
      logger.info('v2 uncommitted-promise floor stood down; the ledger answered', {
        agentId, turnNumber, reason: promise.reason,
      }, agentId);
    } else {
      state = persistEngineSteer(
        state,
        {
          agentId, content: uncommittedPromiseSteer(promise), turnNumber,
          floor: 'uncommitted-promise', atLoop: state.loopCount,
        },
        { broadcast },
      );
      logger.info('v2 uncommitted-promise floor fired: the reply claims a recorded commitment the ledger does not hold, re-entering', {
        agentId, turnNumber, wentToMemory: promise.wentToMemory,
      }, agentId);
      return continueLoop(state); // re-enter so the agent records the promise or says it is not tracked
    }
  }

  // ── Deliverable-claim floor: REMOVED same day it landed (2026-07-19) ──
  // The first full battery with it live proved the design law it violated:
  // prose classification must never gain authority. The floor steered a
  // TRUTHFUL completion (a checklist task whose work WAS its technique_read
  // calls, reads are not in any artifact-receipt list) and the floor model
  // answered the steer by spiraling re-reads until turns blew their windows
  // (run bmrrg3lk3db: use-technique loop, simple-reply timeout). Claims
  // honesty is enforced where it can be DETERMINISTIC instead: delivery
  // outcomes are handed to the model at the source (image completion, fan-
  // out steer payloads, attachment give-up notes), and the behavioral
  // harness keeps the SURFACE-ONLY claims:completion_without_receipts
  // invariant, which observes and reports but never acts on prose.

  // Cross-turn respond-once (attribution redesign §4.5). The within-turn dedup
  // above only compares against the single most-recent assistant message and is
  // exempt on tool-bearing turns, so it misses the real leak: the agent
  // RE-ENGAGES the same conversation a few turns later and re-posts a
  // near-identical reply ("Dry cleaning set for 6pm, dentist not found" twice).
  // Close the loop by comparing against the last few persisted assistant replies
  // (suppressed turns were never persisted, so the DB holds only shown text).
  //
  // GOVERNING RULE (comms-audit G-SUP-1): suppression NEVER applies on a turn a
  // human is waiting on. If a user asked (hasUnansweredUser), including asking
  // the SAME thing again, where the correct answer is necessarily near-identical
  // ("what's on my calendar?" twice), the reply is a genuine answer and must be
  // delivered, never eaten as a "duplicate." Cross-turn dedup is ONLY for the
  // agent spontaneously RE-POSTING with no new user ask driving the turn.
  // 2026-07-03: a DELIBERATE ENGINE SURFACE (scheduler/reminder/completion
  // report) is likewise a new external event driving the turn, and its text is
  // repeated near-identical BY DESIGN, so it is exempt too (run bmr5637ptnc:
  // this guard ate a reminder delivery twice and the turn ended silent).
  if (persistedContent && persistedContent.trim().length > 0 && !triggerRow && !deliberateSurfaceTurn) {
    try {
      const recentReplies = db
        .prepare(
          "SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' AND content NOT LIKE '[{%' ORDER BY rowid DESC LIMIT 5",
        )
        .all(agentId) as Array<{ content: string }>;
      if (recentReplies.some(r => isNearDuplicateText(r.content, persistedContent!))) {
        logger.info('v2: suppressed cross-turn near-duplicate reply (respond-once)', {
          turnNumber,
        }, agentId);
        persistedContent = null;
      }
    } catch {
      // best-effort; never block a reply on a dedup read failure
    }
  }

  // ── Duplicate-final-answer prevention (v2.7.2, scoped down v2.7.3) ──
  //
  // The v2.7.2 fix exited the loop whenever the agent paired wrap-up
  // text with ANY task-closing tool call (work_update(action="close_project"),
  // work_update(action="complete_step"), work_update(action="status") with terminal
  // status, complete_task). The intent was good (skip the duplicate
  // "All set." follow-up turn) but the trigger was way too broad:
  //
  //   • Multi-step user asks where step 1 is a close-out got cut
  //     off after step 1 and never reached step 2.
  //   • Agents naturally mark intermediate task transitions with
  //     "Step done, moving on to X", that paired text+close-out
  //     killed the loop mid-flow.
  //   • The v2.7.3 DB-based "any remaining queued work?" check
  //     helped for tracker-tracked workflows but still cut off
  //     conversational multi-step asks where the next step lives
  //     only in the user's prompt, not in the tracker.
  //
  // Narrowed in v2.7.3 to fire ONLY for `complete_task`, the
  // sub-agent self-termination tool. Its semantics are unambiguous:
  // "I am a sub-agent, my work is over, terminate me and report
  // back to parent." Letting the loop run one more iteration after
  // complete_task would only produce a wasted "all done" follow-up
  // before the agent gets terminated anyway.
  //
  // Every tracker close-out path is now allowed to flow into the
  // next loop iteration. The worst case is one extra model call
  // that emits a brief duplicate "all set" line, minor polish
  // issue. The previous trigger broke real multi-step work, which
  // is a far worse failure mode.
  const isSubAgentExit = (tc: { name: string }): boolean => tc.name === 'complete_task';
  const hasSubAgentExit = result.toolCalls.some(isSubAgentExit);
  const hasWrapUpText = !!(result.content && result.content.trim().length >= 10);

  if (
    !state.taskClosedWithTextThisTurn &&
    hasSubAgentExit &&
    hasWrapUpText
  ) {
    // Force loop exit AFTER this iteration's tool execution. The complete_task
    // tool still runs (it's already in result.toolCalls and processed below this
    // block); the `while` head then sees the LATCH and exits without calling the
    // model again.
    //
    // ⚠ PHASE-6 T6 (CUT 8): a `phase: 'done'` rode beside the latch here and its
    // comment claimed the loop head saw it. IT NEVER DID. This block cannot be
    // reached without tool calls, so the driver's own unconditional
    // `advance(state, { phase: 'execute' })` overwrote it four statements later on
    // every path that reaches here — the exact defect `steps/step-outcome.ts` was
    // written about, one level down. The latch is the mechanism and always was;
    // the write was deleted with the sentence that misdescribed it, and the latch
    // got the first test it has ever had in the same commit
    // (`agent/v2/__tests__/integration.test.ts`, both arms). T13 INBOUND.
    state = advance(state, {
      taskClosedWithTextThisTurn: true,
    });
    logger.info('v2: sub-agent complete_task + wrap-up text, phase set to done, no second model call', {
      agentId,
    }, agentId);
  }

  sc.persistedContent = persistedContent;
  return proceed(state);
}
