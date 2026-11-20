// Reply-destination resolver: decides WHERE the terminal reply goes, then queues it for the channel sender,
// speaks it on a live call, or records why it was held. Exactly one of those happens.
// The dev test kit's instrument manifest anchors on the entry guard line below; keep its text unchanged.

import { createLogger } from '../../../../logger.js';
import { isPrimaryAgent } from '../../../../config/platform.js';
import { redactHandedCredentials } from '../../../../credentials/secret-fields.js';
import { resolveRecipientDisplay } from '../../../../contacts/resolve-recipient.js';
import type { PresenceStatus } from '../../../../services/presence.js';
import { recordAffinityPromotion, affinityPromotionRefusedNoBasis } from '../../owner-affinity.js';
import { outboundRoot, describeOutboundRoot } from '../../outbound-root.js';
import { resolveDeliveryChannel } from '../../turn-address.js';
import { steerFired } from '../../steer-queue.js';
import { withOutboundAsync, recordHeld, recordedId } from '../../outbound.js';
import { queueReply } from '../../deliveries.js';
import { replyAddressFor } from '../../channel-sender.js';
import { engineMayRouteTo, engineRouteRefusalReason } from '../../../access/engine-route.js';
import type { ReplyDestination } from '../../reply-destination.js';
import { advance, type AgentTurnState } from '../../state.js';
import { appendUndeliveredLinks } from './link-backstop.js';
import type { FinalizeContext } from './index.js';
import { postAgentNotice } from '../../../agent-notice.js';

const logger = createLogger('v2-loop');

/** Returns the state it advanced. `said` is the reply as it stood before finalize added to it: after an early
 *  answer, only what was added since (a caption, download links) is queued. */
export async function routeTerminalReply(
  state: AgentTurnState,
  ctx: FinalizeContext,
  said = state.lastAssistantTextForIM ?? '',
): Promise<AgentTurnState> {
  const { agentId, turnNumber, turnCtx, counterparty, chosenConvKey, settledContextWakeTurn, isEngineTurn } = ctx;

  // Chips (a canvas document, the live screen) stay on the dashboard; real files ride the reply.
  const files = turnCtx.replyFiles.filter((f) => !f.openInCanvas && !f.screenShare).map((f) => f.path);
  // Route the reply back to the inbound channel, else the dashboard (iMessage if the owner is away).
  if (isPrimaryAgent(agentId) && (state.lastAssistantTextForIM || files.length > 0)) {
    try {
      const { getPresence, isImessageConfigured } = await import('../../../../services/presence.js');

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
      // Files go only by iMessage, so a turn with files and no words routes only there, as a reply with no text.
      if (!state.lastAssistantTextForIM && (destination !== 'imessage' || files.length === 0)) return state;
      if (state.lastAssistantTextForIM === null) state = advance(state, { lastAssistantTextForIM: '' });
      state = await appendUndeliveredLinks(state, ctx);
      // An answer already queued mid-turn is not queued again: only what finalize added to it follows it.
      const linksOnly = state.lastAssistantTextForIM!.slice(said.trimEnd().length).trim();
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
        // A required reply is the agent's own answer to the person waiting; same standing.
        forcedReply: steerFired(state.steerQueue, 'forced-reply'),
      });
      const settledContextHold = routeRoot.held;
      // One line per settled-wake user-facing outbound, with the outcome and the root that permitted it.
      if (settledContextWakeTurn && counterparty.kind !== 'agent') {
        const heldNow = (settledContextHold || !!turnCtx.pushHeld) && destination !== 'dashboard';
        logger.warn('settled-context tripwire: user-facing outbound from a wake turn whose visible conversations were all answered; verify it is a genuine delivery and not a re-answer', {
          agentId, turnNumber, convKey: chosenConvKey ?? null,
          inboundChannel: state.inboundChannel, presence: presenceNow, destination,
          outcome: heldNow ? 'held' : (destination === 'dashboard' ? 'dashboard' : `channel:${destination}`),
          outboundRoot: routeRoot.root, outboundRoots: routeRoot.roots,
          explicitSend: Object.values(state.explicitSendThisTurn).some(Boolean),
          snippet: (state.lastAssistantTextForIM ?? '').replace(/\s+/g, ' ').slice(0, 140),
        }, agentId);
      }

      await sendOrHold(state, ctx, { destination, settledContextHold, routeRoot, presenceNow, imessageConfigured: isImessageConfigured(), linksOnly, files });
    } catch (err) {
      logger.warn('v2.7.23: reply-destination routing failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  return state;
}

interface RouteDecision {
  readonly destination: ReplyDestination;
  readonly settledContextHold: boolean;
  readonly routeRoot: ReturnType<typeof outboundRoot>;
  readonly presenceNow: PresenceStatus;
  readonly imessageConfigured: boolean;
  readonly linksOnly: string;
  readonly files: string[];
}

const TEXT_CHANNELS = ['imessage', 'sms', 'email', 'teams'] as const;
const isTextChannel = (d: ReplyDestination): d is typeof TEXT_CHANNELS[number] => (TEXT_CHANNELS as readonly string[]).includes(d);

/** Queues, speaks or holds the terminal reply. It never advances the state. */
async function sendOrHold(stateIn: AgentTurnState, ctx: FinalizeContext, r: RouteDecision): Promise<void> {
  // The caller already asserted this non-null at run time (`link-backstop.ts`); restated as a type only.
  const state = stateIn as AgentTurnState & { lastAssistantTextForIM: string };
  const { agentId, turnNumber, turnCtx, counterparty, persistRoutingMarker } = ctx;
  const { destination, settledContextHold, routeRoot, presenceNow } = r;
  const conversationId = turnCtx.root?.conversationId ?? null;

  if ((settledContextHold || !!turnCtx.pushHeld) && destination !== 'dashboard') {
    // No affirmative root on a settled wake, or the proactive limit: withhold the push, keep the reply in the
    // dashboard and mark the pill "held". The held row carries why, so a hold reads apart from a push.
    recordedId(recordHeld({ agentId, tool: 'auto-route', channel: 'dashboard', conversationId }, turnCtx.pushHeld ?? describeOutboundRoot(routeRoot)),
      'v2: settled-context hold', { agentId, turnNumber });
    persistRoutingMarker(turnCtx.pushHeld ? 'held in dashboard: the proactive limit' : 'held in dashboard: no active conversation');
    logger.warn('settled-context hold: withheld auto-route channel push; reply stays visible in dashboard', {
      agentId, turnNumber, destination, presence: presenceNow,
      outboundRoot: routeRoot.root, pushHeld: turnCtx.pushHeld,
    }, agentId);
    if (turnCtx.pushHeld) tellAgentReplyHeld(agentId, destination, 'the owner has not answered your last messages sent on your own', '');
  } else if (destination !== 'dashboard' && !engineMayRouteTo(agentId, destination)) {
    // One channel-grant door for every arm; the reply stays in the dashboard.
    recordedId(recordHeld({ agentId, tool: 'auto-route', channel: destination, conversationId }, engineRouteRefusalReason(destination)),
      'v2: auto-route withheld (no channel grant)', { agentId, turnNumber, destination });
    persistRoutingMarker('held (no channel grant)');
    logger.warn('auto-route withheld: the sending agent holds no grant on this channel', {
      agentId, turnNumber, destination,
    }, agentId);
    tellAgentReplyHeld(agentId, destination, 'you have no permission to send on that channel');
  } else if (destination === 'phone' && !state.repliedToCounterpartyThisTurn.phone && state.inboundContext?.phoneCallSid) {
    await speakOnCall(state, ctx);
  } else if (isTextChannel(destination) && !state.repliedToCounterpartyThisTurn[destination]) {
    const text = turnCtx.earlyAnswerRowId ? r.linksOnly : state.lastAssistantTextForIM;
    if (!text && r.files.length === 0) return;
    // An iMessage reply goes to this turn's iMessage counterparty; with none (the away override) to the owner.
    const sender = counterparty.kind === 'user' && counterparty.channel === 'imessage' ? counterparty.senderId ?? undefined : undefined;
    const address = destination === 'imessage' && !r.imessageConfigured
      ? null
      : replyAddressFor({ ...state.inboundContext, channel: destination, sender, relation: counterparty.kind === 'user' ? counterparty.relation : undefined });
    const queued = address !== null && await queueReply({ agentId, turnNumber, root: turnCtx.root ?? null, text, address, files: r.files, kind: turnCtx.earlyAnswerRowId ? 'download-links' : 'reply' }) !== null;
    if (!queued) {
      recordedId(recordHeld({ agentId, tool: 'auto-route', channel: destination, conversationId }, `no ${destination} address to reply to; the reply is in the dashboard chat`),
        'v2: auto-route held (no address)', { agentId, turnNumber, destination });
      if (address === null) tellAgentReplyHeld(agentId, destination, `there was no ${destination} address to send it to`);
    }
  }
}

const REACH_THEM_ANOTHER_WAY = ' If they need to hear it, reach them another way in your own words.';

/** The agent is told once that its reply stayed in the dashboard: nothing sends a held reply later. */
function tellAgentReplyHeld(agentId: string, destination: ReplyDestination, why: string, after = REACH_THEM_ANOTHER_WAY): void {
  postAgentNotice({
    toAgentId: agentId, fromName: 'Reply delivery', selfIntro: false,
    brief: `Your reply did not go out on the ${destination} channel: ${why}, so it stayed in the dashboard chat and will not be sent later. Do not say it arrived.${after}`,
  });
}

/** Speaks the reply on the active call. If streaming TTS already spoke the body, only the remaining tail is
 *  queued; otherwise the whole reply, so it is never silently dropped. */
async function speakOnCall(state: AgentTurnState & { lastAssistantTextForIM: string }, ctx: FinalizeContext): Promise<void> {
  const { agentId, turnCtx, persistRoutingMarker } = ctx;
  const inbound = state.inboundContext!;
  const replyOut = redactHandedCredentials(agentId, state.lastAssistantTextForIM);
  try {
    const { getCallSession } = await import('../../../../twilio/call-session.js');
    const session = getCallSession(inbound.phoneCallSid!);
    if (!session) {
      logger.warn('v2.9.18: phone auto-reply skipped - no active session for callSid', {
        agentId, callSid: inbound.phoneCallSid,
      }, agentId);
    } else if (session.isEnded()) {
      logger.warn('v2.9.18: phone auto-reply skipped - call already ended', {
        agentId, callSid: inbound.phoneCallSid,
      }, agentId);
    } else if (turnCtx.phoneStreamFlushedAny) {
      const tail = redactHandedCredentials(agentId, turnCtx.phoneStreamBuffer.takeRaw()).trim();
      if (tail) {
        // One reply is one outbound row, however many sentences it is spoken in.
        await withOutboundAsync(
          {
            agentId, tool: 'auto-route', channel: 'phone',
            recipientId: inbound.phoneFromNumber ?? null,
            conversationId: turnCtx.root?.conversationId ?? null,
          },
          () => session.queueAgentSay(tail),
        );
      }
      persistRoutingMarker(`phone call to ${resolveRecipientDisplay('phone', inbound.phoneFromNumber ?? '(unknown)')}`);
      logger.info('v2.9.23: routed reply via phone TTS (streamed)', {
        agentId,
        callSid: inbound.phoneCallSid,
        tailLength: tail.length,
        totalTextLength: replyOut.length,
      }, agentId);
    } else {
      await withOutboundAsync(
        {
          agentId, tool: 'auto-route', channel: 'phone',
          recipientId: inbound.phoneFromNumber ?? null,
          conversationId: turnCtx.root?.conversationId ?? null,
        },
        () => session.queueAgentSay(replyOut),
      );
      persistRoutingMarker(`phone call to ${resolveRecipientDisplay('phone', inbound.phoneFromNumber ?? '(unknown)')}`);
      logger.info('v2.9.18: routed reply via phone TTS', {
        agentId,
        callSid: inbound.phoneCallSid,
        textLength: replyOut.length,
      }, agentId);
    }
  } catch (err) {
    logger.warn('v2.9.18: phone auto-reply crashed', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
