// Reply-destination resolver: decides WHERE the terminal reply goes; `channel-push.ts` sends it.
// The dev test kit's instrument manifest anchors on the entry guard line below; keep its text unchanged.

import { createLogger } from '../../../../logger.js';
import { isPrimaryAgent } from '../../../../config/platform.js';
import { recordAffinityPromotion, affinityPromotionRefusedNoBasis } from '../../owner-affinity.js';
import { outboundRoot } from '../../outbound-root.js';
import { resolveDeliveryChannel } from '../../turn-address.js';
import { steerFired } from '../../steer-queue.js';
import type { AgentTurnState } from '../../state.js';
import { appendUndeliveredLinks } from './link-backstop.js';
import { pushReplyToChannel } from './channel-push.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

/** Returns the state it advanced. */
export async function routeTerminalReply(
  state: AgentTurnState,
  ctx: FinalizeContext,
): Promise<AgentTurnState> {
  const { agentId, turnNumber, turnCtx, counterparty, chosenConvKey, settledContextWakeTurn, isEngineTurn } = ctx;

  // Route the reply back to the inbound channel, else the dashboard (iMessage if the owner is away).
  if (isPrimaryAgent(agentId) && state.lastAssistantTextForIM) {
    try {
      state = await appendUndeliveredLinks(state, ctx);

      const { getPresence, isImessageConfigured } = await import('../../../../services/presence.js');
      const { sendResponseViaIMessage } = await import('../../../../services/imessage-bridge.js');

      const presenceNow = getPresence();
      // Affinity alone is not consent: an affinity-only promotion with no basis is refused. The bound
      // inbound comes from the turn's address, since a continuation has no trigger row.
      const boundInbound = turnCtx.address ? turnCtx.address.boundChannel : state.inboundChannel;
      const affinityRefused = affinityPromotionRefusedNoBasis({
        ownerAffinityChannel: turnCtx.ownerAffinityDestination,
        inboundChannel: boundInbound,
        presence: presenceNow,
        personAskedHere: (turnCtx.address?.kind ?? (counterparty.kind === 'agent' ? 'agent' : 'person')) === 'person',
      });
      if (affinityRefused) {
        logger.info('v2.7.23 route: affinity iMessage promotion refused (no basis: no inbound with the owner not away, or the owner asked on the dashboard); text stays in dashboard', {
          agentId, turnNumber, convKey: chosenConvKey ?? null, presence: presenceNow,
        }, agentId);
      }
      const effectiveOwnerAffinity = affinityRefused ? null : turnCtx.ownerAffinityDestination;
      // One source for the rule: the resolver that told the agent where its reply goes. An agent
      // counterparty never auto-routes to a person; without an address the counterparty says so.
      const routeAddress = turnCtx.address ?? {
        kind: counterparty.kind === 'agent' ? 'agent' as const : 'person' as const,
        isOwner: counterparty.kind === 'user' && counterparty.relation === 'owner',
        boundChannel: state.inboundChannel, autoRoutes: true,
      };
      const destination = resolveDeliveryChannel(routeAddress, {
        presence: presenceNow,
        imessageBridgeConfigured: isImessageConfigured(),
        ownerAffinityChannel: turnCtx.ownerAffinityDestination,
      });
      // Record the promotion only when affinity drove this reply onto iMessage with the owner not
      // away, so the per-conversation cooldown keeps a wake storm from becoming a text storm.
      if (destination === 'imessage' && effectiveOwnerAffinity === 'imessage' && presenceNow !== 'away') {
        recordAffinityPromotion(agentId, turnCtx.ownerAffinityConversationId);
      }

      // A user-facing CHANNEL PUSH needs an affirmative root (`outbound-root.ts`); with none it is held.
      // Only the push is withheld: the reply stays persisted and visible in the dashboard.
      const routeRoot = outboundRoot({
        inboundChannel: boundInbound,
        settledContextWakeTurn,
        counterpartyKind: counterparty.kind,
        isEngineTurn,
        // A steered closeout reply is the completion ack in the agent's own voice; same standing.
        steeredForSilentCloseout: steerFired(state.steerQueue, 'silent-closeout'),
      });
      const settledContextHold = routeRoot.held;
      // One line per settled-wake user-facing outbound, with the outcome and the root that permitted it.
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
