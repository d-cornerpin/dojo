// ════════════════════════════════════════
// PHASE-6 T9 (CUT 4) — THE REPLY-DESTINATION RESOLVER
//
// Relocated verbatim from `agent/v2/loop.ts` (`:8026`–`:8241` and `:8566`–`:8572` at
// `0942fd9`). Bounds, wording and log lines unchanged; the channel branches themselves
// are `channel-push.ts`, split on the seam the block already had (the resolver decides
// WHERE, the push does the sending).
//
// ⚠ THIS FILE CARRIES THE KIT'S INSTRUMENT ANCHOR (GUARD-AUDIT F2). The harness
// patches the entry guard below — `if (isPrimaryAgent(agentId) && …)` — so a dedicated
// test agent is route-eligible in dev sim mode. `dojo-test-kit/server-instruments/
// manifest.mjs` is re-pointed at this file in the same task, because `install.mjs`
// pre-checks every anchor and exits 1: a cut that ignored it would strand every
// subsequent battery run. The anchor TEXT is unchanged except for the two spaces of
// indentation the new nesting depth forces, and the patch's own lazy import is
// re-based one directory level, exactly as the executor's anchor move (`e05860f`) did.
// ════════════════════════════════════════

import { createLogger } from '../../../../logger.js';
import { isPrimaryAgent } from '../../../../config/platform.js';
import { tagTurnOutputConversationId } from '../../../../memory/message-store.js';
import { recordAffinityPromotion, affinityPromotionRefusedNoBasis } from '../../owner-affinity.js';
import { outboundRoot } from '../../outbound-root.js';
import { steerFired } from '../../steer-queue.js';
import type { AgentTurnState } from '../../state.js';
import { appendUndeliveredLinks } from './link-backstop.js';
import { pushReplyToChannel } from './channel-push.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

/**
 * Returns the state it advanced. `engineCompletionAckThisTurn` arrives as an argument
 * rather than on the context because it is produced by the step BEFORE this one, in
 * the same span — a value, computed and consumed inside one call of `runFinalize`.
 */
export async function routeTerminalReply(
  state: AgentTurnState,
  ctx: FinalizeContext,
  engineCompletionAckThisTurn: boolean,
): Promise<AgentTurnState> {
  const { agentId, turnNumber, turnCtx, counterparty, chosenConvKey, settledContextWakeTurn, isEngineTurn } = ctx;
  // PHASE-6 T9 (CUT 4): the conversation this turn serves is read from the TURN'S BAG,
  // which is where the driver publishes it (`loop.ts`'s one writer, whose own comment
  // says "MOVED, not doubled — a second `.set()` is two owners of one fact"). The
  // driver local it used to read is the same value by construction — one write, before
  // the loop, and the publication is the statement after it — so this is the crossing
  // dissolving into a field that already exists rather than a second copy of the fact.
  const chosenConversationId = turnCtx.conversationId ?? null;

  // ── Reply-destination resolver (v2.7.23, OpenClaw-inspired) ──
  // The model just writes text; the engine decides which channel to
  // route it through. The 2.7.22 "model must call imessage_send for
  // every reply" pattern failed in practice (the model defaults to
  // streaming text and can't reliably switch to tool mode for short
  // conversational replies), historical investigation logged
  // separately in the iMessage-routing fix notes.
  //
  // Routing rules (see reply-destination.ts):
  //   - inbound from channel X → reply auto-routes back to X
  //   - dashboard inbound / proactive turn → dashboard
  //   - AWAY OVERRIDE: dashboard destination + presence='away' +
  //     bridge configured → rewrite to iMessage so the user (who
  //     isn't at the dashboard) gets the message on their phone
  //
  // Dedup: if the agent already called the channel's explicit send
  // tool this turn (state.explicitSendThisTurn[channel]), skip the
  // auto-route, they handled it directly.
  if (isPrimaryAgent(agentId) && state.lastAssistantTextForIM) {
    try {
      state = await appendUndeliveredLinks(state, ctx);
      // Turn continuity: this turn produced a terminal reply for its human
      // counterparty. Tagging this turn's messages with the conversation's
      // conv_key (below) is BOTH the durable "served" signal (the next turn
      // moves on to the next waiting conversation rather than re-answering this
      // one, and it survives a restart) AND the content-isolation tag. A turn
      // that ends WITHOUT reaching here (interrupted by a gate/limit mid-task)
      // tags nothing, so the conversation stays waiting and resumes under the
      // SAME counterparty, routing correctly.
      // Tag this turn's OWN messages with the conversation they belong to, so a
      // later turn for a different counterparty never sees this turn's reply or
      // work in its live tail (content bleed across conversations).
      if (chosenConvKey) {
        try { if (chosenConversationId) tagTurnOutputConversationId({ agentId, turnNumber, conversationId: chosenConversationId }); } catch { /* best effort */ }
      }

      const { resolveReplyDestination } = await import('../../reply-destination.js');
      const { getPresence, isImessageConfigured } = await import('../../../../services/presence.js');
      const { sendResponseViaIMessage } = await import('../../../../services/imessage-bridge.js');

      // Invariant #2 (attribution redesign): an A2A turn's reply goes to the
      // other agent via send_to_agent, its trailing text must NEVER route to
      // a human channel. Without this guard, resolveReplyDestination falls
      // through to the dashboard default and the "away" override then promotes
      // it to iMessage, texting the OWNER an answer meant for another agent
      // (observed: the PM agent's A2A question answered by texting the owner). Force the
      // no-auto-route value ('dashboard' matches none of the channel branches
      // below) when this turn's counterparty is an agent.
      const presenceNow = getPresence();
      // ── Turn-anchored auto-route (phantom-outreach fix, 2026-07-18) ──
      // The 3:32 AM phantom: a background wake with NO inbound this turn produced
      // user-facing text, and this auto-route promoted it to the owner's phone on
      // channel AFFINITY ALONE (owner's recent channel), inboundChannel null, owner
      // not away. Affinity is not consent. Refuse the affinity-only promotion here,
      // at the destination computation (not the send site): downgrade to dashboard.
      // The two affirmative bases survive untouched inside resolveReplyDestination,
      // a human iMessage counterparty (Layer 1) and the away-owner promotion (Layer
      // 2), and the model-initiated imessage_send TOOL path is a separate, explicit
      // act that never reaches here.
      const affinityRefused = affinityPromotionRefusedNoBasis({
        ownerAffinityChannel: turnCtx.ownerAffinityDestination,
        inboundChannel: state.inboundChannel,
        presence: presenceNow,
      });
      if (affinityRefused) {
        logger.info('v2.7.23 route: affinity-only iMessage promotion refused, no inbound this turn and owner not away; text stays in dashboard', {
          agentId, turnNumber, convKey: chosenConvKey ?? null, presence: presenceNow,
        }, agentId);
      }
      const effectiveOwnerAffinity = affinityRefused ? null : turnCtx.ownerAffinityDestination;
      const destination = counterparty.kind === 'agent'
        ? 'dashboard'
        : resolveReplyDestination({
            state,
            presence: presenceNow,
            imessageBridgeConfigured: isImessageConfigured(),
            // RC-10: owner-channel affinity, resolved once at turn start (rate limited
            // per conversation). Only the owner qualifies, never a contact. Nulled
            // above when affinity would be the sole basis (phantom-outreach fix).
            counterpartyIsOwner: counterparty.kind === 'user' && counterparty.relation === 'owner',
            ownerAffinityChannel: effectiveOwnerAffinity,
          });
      // RC-10: if the affinity promotion is what put this reply on iMessage (the away
      // override would have promoted regardless, but affinity is a distinct, rate-
      // limited mechanism), record it so a background-wake storm can't become a text
      // storm. Recorded only when the promotion actually resolves to iMessage AND
      // affinity DROVE it this turn (effectiveOwnerAffinity, so a refused promotion
      // never starts a cooldown) AND the owner is not away; the per-conversation
      // cooldown starts now.
      if (destination === 'imessage' && effectiveOwnerAffinity === 'imessage' && presenceNow !== 'away') {
        recordAffinityPromotion(agentId, turnCtx.ownerAffinityConversationId);
      }

      // ── Settled-context hold (phantom-outreach fix, 2026-07-18) ──
      // The single settled-context tripwire implementation (moved here from the
      // in-loop calibration site so the hold can reach the route decision). This turn
      // started with every visible user conversation already answered; a user-facing
      // outbound with NO inbound this turn (inboundChannel null) and no active human
      // conversation is the phantom shape. For it we withhold the auto-route CHANNEL
      // PUSH: no iMessage/SMS/etc. push fires. This is channel discipline, NOT reply
      // suppression, the reply text stays persisted and visible in the dashboard chat
      // exactly as it already is (design law: never suppress agent replies; only the
      // outbound PUSH is withheld). Carve-outs keep genuine proactive deliveries
      // flowing to an away owner: an A2A turn (forced to dashboard anyway), an engine
      // turn (a scheduler/reminder the agent must deliver), and an engine completion
      // ack (a real "done" for just-finished work, always-ack hard rule) are never
      // held.
      // PHASE-4 T4 — THE CARVE-OUT PILE IS DISSOLVED (scar-tissue ledger :102, verdict
      // STRIP, precondition "P4 provides the affirmative-basis read"). What stood here was
      // six booleans ANDed, five of them negations, whose meaning existed only as a
      // conjunction — and every new exemption was one more `&& !flag`, which is how a pile
      // becomes a pile. The rule is stated once and positively now: a user-facing CHANNEL
      // PUSH requires an AFFIRMATIVE ROOT, and each old negation is one named root
      // (`agent/v2/outbound-root.ts`). No root -> held. The dissolution is EXACT and it is
      // proven by exhausting all 64 input combinations against the original expression,
      // transcribed verbatim into `__tests__/outbound-root.test.ts` as the oracle.
      //
      // requirement preserved: "user-facing outbound needs an affirmative root; carve-outs
      // become root kinds, not boolean flags" — the ledger's own line, discharged here.
      // Design law untouched: only the PUSH is withheld; the reply stays persisted, broadcast
      // and visible in the dashboard exactly as it already is.
      const routeRoot = outboundRoot({
        inboundChannel: state.inboundChannel,
        settledContextWakeTurn,
        counterpartyKind: counterparty.kind,
        isEngineTurn,
        engineCompletionAckThisTurn,
        // A steered closeout reply IS the completion ack, in the agent's own
        // voice (owner ruling 2026-07-22); it keeps the same standing.
        steeredForSilentCloseout: steerFired(state.steerQueue, 'silent-closeout'),
      });
      const settledContextHold = routeRoot.held;
      // Calibration log (2026-07-09 re-answer class + the phantom outcome), one line
      // per settled-wake user-facing outbound, carrying the routing outcome AND the root
      // that permitted it — "why did this go out" was unanswerable from a conjunction.
      if (settledContextWakeTurn && counterparty.kind !== 'agent') {
        const heldNow = settledContextHold && destination !== 'dashboard';
        logger.warn('settled-context tripwire: user-facing outbound from a wake turn whose visible conversations were all answered; verify it is a genuine delivery and not a re-answer', {
          agentId, turnNumber, convKey: chosenConvKey ?? null,
          inboundChannel: state.inboundChannel, presence: presenceNow, destination,
          outcome: heldNow ? 'held' : (destination === 'dashboard' ? 'dashboard' : `channel:${destination}`),
          outboundRoot: routeRoot.root, outboundRoots: routeRoot.roots,
          explicitSend: Object.values(state.explicitSendThisTurn).some(Boolean),
          snippet: (state.lastAssistantTextForIM ?? '').replace(/\s+/g, ' ').slice(0, 140),
        }, agentId);
      }

      await pushReplyToChannel(state, ctx, {
        destination, settledContextHold, routeRoot, presenceNow,
        isImessageConfigured, sendResponseViaIMessage, getPresence,
      });
    } catch (err) {
      logger.warn('v2.7.23: reply-destination routing failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  return state;
}
