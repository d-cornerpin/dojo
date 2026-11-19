// Floors that read the reply itself: the truth guards (the reply asserts X, the ledger says not-X),
// the cross-turn near-duplicate hold, and the sub-agent exit latch.

import { openBoardTitlesBefore } from '../../open-work-names.js';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { advance, type AgentTurnState } from '../../state.js';
import { steerFired, steerPriority, type SteerFloorId } from '../../steer-queue.js';
import { persistEngineSteer } from '../../engine-steer.js';
import { channelLabel, findRecentDeliveriesKeyed, relativeTimeAgo } from '../../outbound-ledger.js';
import { isNearDuplicateText } from '../../classifiers/loop.js';
import { detectDeliveryDenial } from '../../classifiers/grounding.js';
import { claimedDeliverySteer, decideClaimedDelivery } from '../../claimed-delivery.js';
import { decideRefusedDelivery, refusedDeliverySteer } from '../../refused-delivery.js';
import { decideUncommittedPromise, openedBoardWorkSince, uncommittedPromiseSteer } from '../../recorded-commitment.js';
import { askReplyClaims, replyClaim } from '../../reply-claims.js';
import { tsToMs } from '../../../../work/tracker-view.js';
import { isBareNoReplySentinel } from '@dojo/shared';
import { continueLoop, proceed, type StepOutcome } from '../step-outcome.js';
import { holdAndSteer } from './closeout-floors.js';
import type { PostCallClassifyContext, PostCallScratch } from './index.js';

const logger = createLogger('v2-loop');

// The truth guards: one prologue, one loop, one exit, sorted by STEER_PRECEDENCE so the order cannot
// drift from the table. Each record keeps its own extra gate, latch position, decision and steer.

/** What a guard files when it fires: the steer's content, and its latch key if it is keyed. */
export interface TruthGuardVerdict {
  readonly content: string;
  readonly key?: string;
}

/** One truth guard: the floor it speaks as, the gate beyond the shared prologue, and its
 *  decision. `decide` returns null when the ledger answers and the guard stands down. */
export interface TruthGuard {
  readonly floor: SteerFloorId;
  readonly gate: (state: AgentTurnState, ctx: PostCallClassifyContext, reply: string) => boolean;
  readonly decide: (
    state: AgentTurnState,
    ctx: PostCallClassifyContext,
    reply: string,
  ) => TruthGuardVerdict | null;
}

const TRUTH_GUARD_SET: TruthGuard[] = [
  // Claimed delivery to a named third party. The prose only narrows which party; the firing is a ledger
  // row (an owed obligation with no delivery, or a contradicting outcome). One steer per row.
  {
    floor: 'ungrounded-claim',
    gate: () => true,
    decide: (state, ctx, reply) => {
      const { agentId, counterparty, turnNumber } = ctx;
      const claim = decideClaimedDelivery({
        agentId,
        turnNumber,
        responseText: reply,
        // Cumulative tool activity (state.toolCalls is empty here); a send the tool refused is not a delivery.
        toolCallsThisTurn: state.toolResults
          .filter((r) => !r.isError)
          .map((r) => ({ name: r.name })),
        counterpartyName: counterparty.name,
        // A real send within 24h grounds the claim, so the floor never forces a duplicate send.
        hasDeliveryReceipt: (recipient) => findRecentDeliveriesKeyed(agentId, recipient, 24).length > 0,
        claimInText: (said) => replyClaim(ctx, 'claims_sent_to_third_party') ?? said,
      });
      if (!claim.fires && claim.recipient) {
        logger.info('v2 claimed-delivery floor stood down; the ledger answered', {
          agentId, recipient: claim.recipient, reason: claim.reason,
        }, agentId);
      }
      // The latch is read here, not in `gate`: it is row-keyed, and the stand-down log above must
      // still fire on a turn whose row was already steered about.
      if (!claim.fires || steerFired(state.steerQueue, 'ungrounded-claim', claim.latchKey)) return null;
      logger.info('v2 claimed-delivery floor fired on a LEDGER row, re-entering', {
        agentId, recipient: claim.recipient, basis: claim.basis,
        obligationId: claim.obligation?.id ?? null, failedDeliveryId: claim.failedDeliveryId,
      }, agentId);
      return { content: claimedDeliverySteer(claim), key: claim.latchKey };
    },
  },

  // Denial direction: the reply denies a delivery the receipt ledger proves happened. Detection is
  // generous; the receipt is the true gate, and the steer says do not re-send.
  {
    floor: 'delivery-denial',
    gate: (state) => !steerFired(state.steerQueue, 'delivery-denial'),
    decide: (_state, ctx, reply) => {
      const { agentId } = ctx;
      const denial = detectDeliveryDenial({ responseText: reply });
      if (!denial.denied) return null;
      // Named recipient: 24h window; bare "not yet": 1h, so an unrelated older send cannot ground it.
      const matches = denial.recipient
        ? findRecentDeliveriesKeyed(agentId, denial.recipient, 24)
        : findRecentDeliveriesKeyed(agentId, null, 1);
      const receipt = matches[0];
      if (!receipt) return null;
      const who = receipt.recipient ?? denial.recipient ?? 'them';
      logger.info('v2 delivery-denial guard fired, receipt contradicts denial, re-entering', {
        agentId, recipient: who, channel: receipt.channel,
      }, agentId);
      return {
        content:
          `[Engine receipt: you DID send ${channelLabel(receipt.channel)} to ${who} ${relativeTimeAgo(receipt.createdAt)}. `
          + `Answer truthfully; do not re-send.]`,
      };
    },
  },

  // Failed save: every vault_remember this turn was rejected and the turn is ending with a reply.
  {
    floor: 'failed-save-claim',
    gate: (state) => !steerFired(state.steerQueue, 'failed-save-claim'),
    decide: (state, ctx) => {
      const { agentId } = ctx;
      const vaultRemembers = state.toolResults.filter((r) => r.name === 'vault_remember');
      const rejected = vaultRemembers.filter((r) => r.isError).length;
      const succeeded = vaultRemembers.filter((r) => !r.isError).length;
      if (!(succeeded === 0 && rejected >= 1)) return null;
      logger.info('v2 save-claim floor fired, all vault saves rejected this turn, re-entering', {
        agentId, rejected,
      }, agentId);
      return {
        content:
          `[System: All ${rejected} vault_remember call${rejected === 1 ? '' : 's'} this turn `
          + `${rejected === 1 ? 'was' : 'were'} REJECTED and nothing was stored. Either retry with the correction the tool `
          + `gave you, or tell the counterpart truthfully that it is not saved yet. Do not claim it was saved.]`,
      };
    },
  },

  // Uncommitted promise: the reply says a commitment is recorded and the ledger has nothing from this
  // turn; across turns the ledger is the latch. It must run here, before the turn-ending floors.
  {
    floor: 'uncommitted-promise',
    gate: (state, ctx) =>
      ctx.counterparty.kind === 'user' &&
      !steerFired(state.steerQueue, 'uncommitted-promise'),
    decide: (state, ctx, reply) => {
      const { agentId, turnNumber, turnStartedAt } = ctx;
      const turnStartedAtMs = tsToMs(turnStartedAt) ?? 0;
      const promise = decideUncommittedPromise({
        agentId,
        responseText: reply,
        // Cumulative tool activity, as above; `result.toolCalls` is empty by the shared gate.
        toolResultsThisTurn: state.toolResults,
        openedWorkThisTurn: () => openedBoardWorkSince(agentId, turnStartedAtMs),
        openBoardTitles: () => openBoardTitlesBefore(agentId, turnStartedAtMs),
      });
      if (!promise.fires) {
        logger.info('v2 uncommitted-promise floor stood down; the ledger answered', {
          agentId, turnNumber, reason: promise.reason,
        }, agentId);
        return null;
      }
      logger.info('v2 uncommitted-promise floor fired: the reply claims a recorded commitment the ledger does not hold, re-entering', {
        agentId, turnNumber, wentToMemory: promise.wentToMemory,
      }, agentId);
      return { content: uncommittedPromiseSteer(promise) };
    },
  },

  // A delivery claimed in a turn whose report tool refused it; `dojo_report` writes no deliveries row,
  // so only this turn's tool record can refute it.
  {
    floor: 'false-delivery-claim',
    gate: (state) => !steerFired(state.steerQueue, 'false-delivery-claim'),
    decide: (state, ctx) => {
      const refused = decideRefusedDelivery(state.toolResults);
      if (!refused) return null;
      logger.info('v2 false-delivery-claim floor fired: every report call this turn was refused, re-entering', {
        agentId: ctx.agentId, refused: refused.refused,
      }, ctx.agentId);
      return { content: refusedDeliverySteer(refused) };
    },
  },
];

export const TRUTH_GUARDS: readonly TruthGuard[] = Object.freeze(
  TRUTH_GUARD_SET.sort((a, b) => steerPriority(a.floor) - steerPriority(b.floor)),
);

/** The floors that read the reply's own words against the ledger. */
export async function runReplyFloors(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
  sc: PostCallScratch,
): Promise<StepOutcome> {
  const { agentId, db, result, triggerRow, turnNumber } = ctx;
  const { deliberateSurfaceTurn, interAgentTurn } = sc;
  const { persistedContent } = sc;
  await askReplyClaims(state, ctx, persistedContent);
  // Shared prologue: a terminal reply on a non-inter-agent turn. The first guard to fire re-enters.
  if (persistedContent && !isBareNoReplySentinel(persistedContent) && result.toolCalls.length === 0 && !interAgentTurn) {
    const reply = persistedContent;
    for (const guard of TRUTH_GUARDS) {
      if (!guard.gate(state, ctx, reply)) continue;
      const verdict = guard.decide(state, ctx, reply);
      if (!verdict) continue;
      // Through the steer door so the model sees it; a bare system row is stripped by the assembler.
      state = persistEngineSteer(
        state,
        {
          agentId, content: verdict.content, turnNumber,
          floor: guard.floor, atLoop: state.loopCount, key: verdict.key,
        },
        { broadcast },
      );
      return continueLoop(state); // re-enter so the agent corrects it or does the thing
    }
  }


  // Cross-turn respond-once: hold a reply near-identical to one of the last few sent. Never on a turn
  // a human or a deliberate engine surface drives, where a repeat is legitimate.
  if (persistedContent && persistedContent.trim().length > 0 && !triggerRow && !deliberateSurfaceTurn) {
    try {
      const recentReplies = db
        .prepare(
          "SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' AND content NOT LIKE '[{%' ORDER BY rowid DESC LIMIT 5",
        )
        .all(agentId) as Array<{ content: string }>;
      const match = recentReplies.find(r => isNearDuplicateText(r.content, persistedContent!));
      if (match) {
        // The agent is told which sent reply this matches and decides; written again, it goes out.
        const prev = match.content.replace(/\s+/g, ' ').trim();
        const held = holdAndSteer(state, { agentId, messageId: ctx.messageId, turnNumber, sc, db: ctx.db }, {
          floor: 'near-duplicate-reply', text: persistedContent,
          steer: `[Engine record: your reply matches one you already sent: "${prev.length > 120 ? `${prev.slice(0, 120)}…` : prev}". `
            + 'It has not been sent; written as your final reply again, it is sent again. A final reply of [no-reply] sends nothing.]',
        });
        if (held) {
          logger.info('v2: held a cross-turn near-duplicate reply and told the agent (field fix 3 #11)', { turnNumber }, agentId);
          return held;
        }
      }
    } catch {
      // best-effort; never block a reply on a dedup read failure
    }
  }

  // A sub-agent's complete_task with wrap-up text ends the loop after this iteration's tools run.
  // Only complete_task: tracker close-outs flow on, since cutting them broke real multi-step work.
  const isSubAgentExit = (tc: { name: string }): boolean => tc.name === 'complete_task';
  const hasSubAgentExit = result.toolCalls.some(isSubAgentExit);
  const hasWrapUpText = !!(result.content && result.content.trim().length >= 10);

  if (
    !state.taskClosedWithTextThisTurn &&
    hasSubAgentExit &&
    hasWrapUpText
  ) {
    // complete_task still runs; the `while` head sees this latch and exits without another model call.
    // A phase write here would be overwritten by the driver, so the latch is the mechanism.
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
