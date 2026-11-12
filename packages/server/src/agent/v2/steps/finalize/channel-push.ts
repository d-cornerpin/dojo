// Channel push: sends the terminal reply where the resolver chose, or records it held. The arms are one
// `else if` chain (held, no grant, iMessage, Teams, email, phone, SMS), so exactly one fires.
// The caller resolves the lazy iMessage and presence imports and passes them in as values.

import { v4 as uuidv4 } from 'uuid';
import type { ToolCall } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { redactHandedCredentials } from '../../../../credentials/secret-fields.js';
import { resolveRecipientDisplay } from '../../../../contacts/resolve-recipient.js';
import { writeToolReceipt } from '../../../../receipts/store.js';
import { executeTool } from '../../../tools/index.js';
import type { PresenceStatus } from '../../../../services/presence.js';
import type { sendResponseViaIMessage as SendViaIMessage } from '../../../../services/imessage-bridge.js';
import type { ReplyDestination } from '../../reply-destination.js';
import { withOutboundAsync, recordHeld, recordedId } from '../../outbound.js';
import { engineMayRouteTo, engineRouteRefusalReason } from '../../../access/engine-route.js';
import { outboundRoot, describeOutboundRoot } from '../../outbound-root.js';
import type { AgentTurnState } from '../../state.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

/** What the resolver worked out, handed to the arm that acts on it. */
export interface RouteDecision {
  readonly destination: ReplyDestination;
  readonly settledContextHold: boolean;
  readonly routeRoot: ReturnType<typeof outboundRoot>;
  readonly presenceNow: PresenceStatus;
  /** Resolved by the caller's own lazy imports. */
  readonly isImessageConfigured: () => boolean;
  readonly getPresence: () => PresenceStatus;
  readonly sendResponseViaIMessage: typeof SendViaIMessage;
}

/** Sends the terminal reply, or records that it was held. It never advances the state. */
export async function pushReplyToChannel(
  stateIn: AgentTurnState,
  ctx: FinalizeContext,
  r: RouteDecision,
): Promise<void> {
  // The caller already asserted this non-null at run time (`link-backstop.ts`); restated as a type only.
  const state = stateIn as AgentTurnState & { lastAssistantTextForIM: string };
  const { agentId, turnNumber, turnCtx, counterparty, persistRoutingMarker } = ctx;

  // Nothing with a credential leaves the box, an owner-bound iMessage included. One scrub for every arm
  // (a per-arm scrub is a place to forget); the reply setters already scrub at birth, so for the reply
  // this second pass keeps the guarantee in the router. The phone arm's streamed tail is scrubbed below,
  // and `stranded-attachments.ts` scrubs its own caption.
  const replyOut = redactHandedCredentials(agentId, state.lastAssistantTextForIM);
  const { destination, settledContextHold, routeRoot, presenceNow, isImessageConfigured, sendResponseViaIMessage, getPresence } = r;

  // `persistRoutingMarker` is the single writer of the dashboard's "to X via Y" pill.

  // A reply to a contact the agent reached for the owner routes back to that contact, not the owner's chat.
  if (settledContextHold && destination !== 'dashboard') {
    // No affirmative root on a settled wake: withhold the push, keep the reply in the dashboard and mark
    // the pill "held". `recordHeld` is the entry point for an outcome where no transport was reached.
    recordedId(recordHeld(
      {
        agentId, tool: 'auto-route', channel: 'dashboard',
        conversationId: turnCtx.root?.conversationId ?? null,
      },
      // The held row carries the root read that produced it, so a hold reads apart from a push.
      describeOutboundRoot(routeRoot),
    ), 'v2: settled-context hold', { agentId, turnNumber });
    persistRoutingMarker('held in dashboard: no active conversation');
    logger.warn('settled-context hold: withheld auto-route channel push (no affirmative root); reply stays visible in dashboard', {
      agentId, turnNumber, destination, presence: presenceNow,
      outboundRoot: routeRoot.root,
    }, agentId);
  } else if (destination !== 'dashboard' && !engineMayRouteTo(agentId, destination)) {
    // One channel-grant door for every arm: most reach a human through a bridge, Twilio or a call, not
    // `executeTool`. After the hold, so held rows keep their reason; the reply stays in the dashboard.
    recordedId(recordHeld(
      {
        agentId, tool: 'auto-route', channel: destination,
        conversationId: turnCtx.root?.conversationId ?? null,
      },
      engineRouteRefusalReason(destination),
    ), 'v2: auto-route withheld (no channel grant)', { agentId, turnNumber, destination });
    persistRoutingMarker('held (no channel grant)');
    logger.warn('auto-route withheld: the sending agent holds no grant on this channel', {
      agentId, turnNumber, destination,
    }, agentId);
  } else if (destination === 'imessage' && !state.repliedToCounterpartyThisTurn.imessage && isImessageConfigured()) {
    // Reply to this turn's iMessage counterparty; undefined (proactive or away) lets the bridge fall back to
    // the owner. The badge names who the bridge actually delivered to, and is skipped on a suppressed send.
    const imRecipient = counterparty.kind === 'user' && counterparty.channel === 'imessage' ? counterparty.senderId : undefined;
    // No iMessage counterparty means the away override promoted this turn: flag it owner-bound so the
    // bridge never routes it to a contact.
    const ownerBound = imRecipient === undefined;
    const replyText = replyOut;
    // The resolver declares who it answers; the bridge door records whether the send landed.
    const delivered = await withOutboundAsync(
      {
        agentId, tool: 'auto-route', channel: 'imessage', text: replyText,
        recipientId: imRecipient ?? null,
        conversationId: turnCtx.root?.conversationId ?? null,
      },
      async () => {
        const d = await sendResponseViaIMessage(replyText, agentId, imRecipient, ownerBound);
        // The engine iMessage auto-route is unverifiable (exit code only) and its receipt says so. Written
        // inside the scope so `deliveries.receipt_id` links to it.
        if (d) writeToolReceipt({ agentId, tool: 'imessage_send', tier: 3, verified: false, basis: 'exit-code', recipient: d.address, sentText: replyText, detail: { route: 'auto', textLength: replyText.length } });
        return d;
      },
    );
    if (delivered) {
      persistRoutingMarker(`iMessage to ${delivered.name}`);
      logger.info('v2.7.23: routed reply via iMessage', {
        agentId,
        inboundChannel: state.inboundChannel,
        recipient: delivered.name,
        presence: getPresence(),
        textLength: replyOut.length,
      }, agentId);
    } else {
      logger.info('v2.7.23: iMessage auto-reply suppressed (no valid recipient)', {
        agentId,
        inboundChannel: state.inboundChannel,
      }, agentId);
    }
  } else if (destination === 'teams' && !state.repliedToCounterpartyThisTurn.teams && state.inboundContext?.chatId) {
    // A Teams DM reply goes back to the same chat through `executeTool` (auth, retries, audit). Group
    // chats never auto-route: inbound classification keeps them on the dashboard.
    try {
      const tc: ToolCall = {
        id: uuidv4(),
        name: 'teams_send_message',
        arguments: {
          chat_id: state.inboundContext.chatId,
          message: replyOut,
        },
      };
      const result = await withOutboundAsync(
        {
          agentId, tool: 'auto-route', channel: 'teams', text: replyOut,
          recipientId: state.inboundContext.chatId, threadRoot: state.inboundContext.chatId,
          conversationId: turnCtx.root?.conversationId ?? null,
        },
        () => executeTool(agentId, tc),
      );
      if (result.kind !== 'applied') {
        logger.warn('v2.7.24: teams auto-reply failed', { agentId, why: result.reason, error: result.result.content }, agentId);
      } else {
        persistRoutingMarker(`Teams to chat ${state.inboundContext.chatId.slice(0, 8)}…`);
        logger.info('v2.7.24: routed reply via Teams', {
          agentId,
          chatId: state.inboundContext.chatId,
          textLength: replyOut.length,
        }, agentId);
      }
    } catch (err) {
      logger.warn('v2.7.24: teams auto-reply crashed', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  } else if (destination === 'email' && !state.repliedToCounterpartyThisTurn.email && state.inboundContext?.emailMessageId) {
    // An email inbound with a message id gets the reply in-thread via outlook_reply or gmail_reply.
    const toolName = state.inboundContext.emailService === 'gmail' ? 'gmail_reply' : 'outlook_reply';
    try {
      const tc: ToolCall = {
        id: uuidv4(),
        name: toolName,
        arguments: {
          message_id: state.inboundContext.emailMessageId,
          body: replyOut,
          // Reply from the same mailbox that received it; with several agent accounts it fails otherwise.
          ...(state.inboundContext.emailAccount ? { account: state.inboundContext.emailAccount } : {}),
        },
      };
      const result = await withOutboundAsync(
        {
          agentId, tool: 'auto-route', channel: 'email', text: replyOut,
          recipientId: state.inboundContext.recipientAddress ?? null,
          provider: state.inboundContext.emailService ?? null,
          conversationId: turnCtx.root?.conversationId ?? null,
        },
        () => executeTool(agentId, tc),
      );
      if (result.kind !== 'applied') {
        logger.warn('v2.7.24: email auto-reply failed', { agentId, tool: toolName, why: result.reason, error: result.result.content }, agentId);
      } else {
        // The badge prefers the recipient address, else the thread subject.
        const emailRecipient = state.inboundContext.recipientAddress;
        const subjectPreview = state.inboundContext.emailSubject?.slice(0, 40) ?? '(no subject)';
        persistRoutingMarker(
          emailRecipient
            ? `email to ${resolveRecipientDisplay('email', emailRecipient)}`
            : `email reply (thread: "${subjectPreview}")`,
        );
        logger.info('v2.7.24: routed reply via email', {
          agentId,
          emailService: state.inboundContext.emailService,
          subject: state.inboundContext.emailSubject,
          textLength: replyOut.length,
        }, agentId);
      }
    } catch (err) {
      logger.warn('v2.7.24: email auto-reply crashed', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  } else if (destination === 'phone' && !state.repliedToCounterpartyThisTurn.phone && state.inboundContext?.phoneCallSid) {
    // Speak the reply on the active call. If streaming TTS already spoke the body, queue only the
    // remaining tail; otherwise push the whole reply, so it is never silently dropped.
    try {
      const { getCallSession } = await import('../../../../twilio/call-session.js');
      const session = getCallSession(state.inboundContext.phoneCallSid);
      if (!session) {
        logger.warn('v2.9.18: phone auto-reply skipped - no active session for callSid', {
          agentId, callSid: state.inboundContext.phoneCallSid,
        }, agentId);
      } else if (session.isEnded()) {
        logger.warn('v2.9.18: phone auto-reply skipped - call already ended', {
          agentId, callSid: state.inboundContext.phoneCallSid,
        }, agentId);
      } else if (turnCtx.phoneStreamFlushedAny) {
        const tail = redactHandedCredentials(agentId, turnCtx.phoneStreamBuffer).trim();
        if (tail) {
          // One reply is one outbound row, however many sentences it is spoken in.
          await withOutboundAsync(
            {
              agentId, tool: 'auto-route', channel: 'phone', text: tail,
              recipientId: state.inboundContext.phoneFromNumber ?? null,
              conversationId: turnCtx.root?.conversationId ?? null,
            },
            () => session.queueAgentSay(tail),
          );
          turnCtx.phoneStreamBuffer = '';
        }
        persistRoutingMarker(`phone call to ${resolveRecipientDisplay('phone', state.inboundContext.phoneFromNumber ?? '(unknown)')}`);
        logger.info('v2.9.23: routed reply via phone TTS (streamed)', {
          agentId,
          callSid: state.inboundContext.phoneCallSid,
          to: state.inboundContext.phoneFromNumber,
          tailLength: tail.length,
          totalTextLength: replyOut.length,
        }, agentId);
      } else {
        const phoneText = replyOut;
        await withOutboundAsync(
          {
            agentId, tool: 'auto-route', channel: 'phone', text: phoneText,
            recipientId: state.inboundContext.phoneFromNumber ?? null,
            conversationId: turnCtx.root?.conversationId ?? null,
          },
          () => session.queueAgentSay(phoneText),
        );
        persistRoutingMarker(`phone call to ${resolveRecipientDisplay('phone', state.inboundContext.phoneFromNumber ?? '(unknown)')}`);
        logger.info('v2.9.18: routed reply via phone TTS', {
          agentId,
          callSid: state.inboundContext.phoneCallSid,
          to: state.inboundContext.phoneFromNumber,
          textLength: replyOut.length,
        }, agentId);
      }
    } catch (err) {
      logger.warn('v2.9.18: phone auto-reply crashed', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  } else if (destination === 'sms' && !state.repliedToCounterpartyThisTurn.sms && state.inboundContext?.smsFromNumber) {
    // Reply to the SMS sender from the number that received it, so the thread stays continuous.
    try {
      const { sendSms } = await import('../../../../twilio/client.js');
      const { getDefaultFromNumber } = await import('../../../../twilio/auth.js');
      const fromNumber = state.inboundContext.smsToNumber ?? getDefaultFromNumber();
      if (!fromNumber) {
        logger.warn('v2.9.18: sms auto-reply skipped - no from-number available', { agentId }, agentId);
      } else {
        const smsTo = state.inboundContext.smsFromNumber;
        const smsText = replyOut;
        const r = await withOutboundAsync(
          {
            agentId, tool: 'auto-route', channel: 'sms', recipientId: smsTo, text: smsText,
            conversationId: turnCtx.root?.conversationId ?? null,
          },
          async () => {
            const res = await sendSms(smsTo, smsText, fromNumber);
            // Tier-1 receipt like the sms_send tool: verified on the Twilio SID, else http-status.
            // Written inside the scope so it links to the delivery row.
            if (res.ok) {
              const sid = res.data.sid;
              writeToolReceipt({ agentId, tool: 'sms_send', tier: 1, verified: !!sid, basis: sid ? 'provider-id' : 'http-status', providerId: sid ?? null, recipient: smsTo, sentText: smsText, detail: { route: 'auto', textLength: smsText.length } });
            }
            return res;
          },
        );
        if (!r.ok) {
          logger.warn('v2.9.18: sms auto-reply failed', { agentId, error: r.error }, agentId);
        } else {
          persistRoutingMarker(`SMS to ${resolveRecipientDisplay('sms', state.inboundContext.smsFromNumber)}`);
          logger.info('v2.9.18: routed reply via SMS', {
            agentId,
            to: state.inboundContext.smsFromNumber,
            from: fromNumber,
            textLength: replyOut.length,
          }, agentId);
        }
      }
    } catch (err) {
      logger.warn('v2.9.18: sms auto-reply crashed', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }
}
