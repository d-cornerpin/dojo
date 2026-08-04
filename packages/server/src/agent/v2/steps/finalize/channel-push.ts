// ════════════════════════════════════════
// PHASE-6 T9 (CUT 4) — THE CHANNEL PUSH
//
// Relocated verbatim from `agent/v2/loop.ts` (`:8243`–`:8565` at `0942fd9`): the
// settled-context hold and the five channel branches, in their original ORDER, which
// is the contract (`held` first, then iMessage, Teams, email, phone, SMS — an
// `else if` chain, so exactly one arm can fire). Bounds, wording, both `chat:error`
// paths and every log line unchanged.
//
// WHY IT IS ITS OWN FILE AND NOT PART OF `route-reply.ts`: 597 + 323 lines against
// the build's 400-line `maxNewFileLines` cap (RULING P6-R1's directory shape is
// NECESSARY here, not merely permitted), and the seam was already in the block — the
// resolver decides WHERE the reply goes, this decides how it is SENT there.
//
// THE FOUR LAZY IMPORTS STAY WHERE THEY WERE. `isImessageConfigured` and
// `sendResponseViaIMessage` are resolved by the caller, in the same statement and at
// the same moment they always were, and arrive here as values — moving the `await
// import` would change WHEN a module is loaded, which a relocation did not admit to.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import type { ToolCall } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { resolveRecipientDisplay } from '../../../../contacts/resolve-recipient.js';
import { writeToolReceipt } from '../../../../receipts/store.js';
import { executeTool } from '../../../tools/index.js';
import type { PresenceStatus } from '../../../../services/presence.js';
import type { sendResponseViaIMessage as SendViaIMessage } from '../../../../services/imessage-bridge.js';
import type { ReplyDestination } from '../../reply-destination.js';
import { withOutboundAsync, recordHeld, recordedId } from '../../outbound.js';
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
  /** Resolved by the caller's own lazy imports — see the header. */
  readonly isImessageConfigured: () => boolean;
  readonly getPresence: () => PresenceStatus;
  readonly sendResponseViaIMessage: typeof SendViaIMessage;
}

/**
 * Sends the turn's terminal reply — or records that it was deliberately HELD. It never
 * advances the state: the span's three `advance` calls are all outside this block, and
 * a walk of the moved range confirms zero here.
 */
export async function pushReplyToChannel(
  stateIn: AgentTurnState,
  ctx: FinalizeContext,
  r: RouteDecision,
): Promise<void> {
  // The caller has ALREADY re-asserted this non-null at run time (`route-reply.ts`,
  // the block's own `unreachable` throw, moved with it and unchanged). What the module
  // boundary loses is the NARROWING, not the guarantee — so it is restated as a type
  // here rather than as a second runtime check, because a duplicated throw would be a
  // second mechanism for one invariant and every branch below would read one `!` wider.
  const state = stateIn as AgentTurnState & { lastAssistantTextForIM: string };
  const { agentId, turnNumber, turnCtx, counterparty, persistRoutingMarker } = ctx;
  const { destination, settledContextHold, routeRoot, presenceNow, isImessageConfigured, sendResponseViaIMessage, getPresence } = r;

  // Outbound routing markers are written via the hoisted
  // persistRoutingMarker helper (defined near deliverEngineUserAck), the
  // single writer shared with the engine-ack channel pushes so the
  // dashboard's "to <recipient> via <channel>" pill wording cannot drift
  // between the two paths.

  // The agent works out details DIRECTLY with whoever it is talking to,
  // including someone it proactively reached on the owner's behalf (the
  // owner asked it to reach a contact). Its reply to that person routes
  // BACK to that person over iMessage; it then brings the result to the
  // owner separately, when it actually has it. That is the whole point of
  // having an agent handle this kind of back-and-forth.
  //
  // This path used to force such a reply to stay in the dashboard, on the
  // assumption the agent's text was a report to the owner, but the agent's
  // reply was addressed to the CONTACT, so a contact-bound message ended up
  // dropped into the owner's chat (the exact failure observed). Removed:
  // a reply to a contact always routes to that contact.
  if (settledContextHold && destination !== 'dashboard') {
    // Held: on this settled wake there is no active conversation to push into,
    // so the auto-route CHANNEL PUSH is withheld. The reply already lives in the
    // dashboard chat (persisted + broadcast above); nothing is deleted or
    // reclassified. Mark it so the dashboard pill reads "held" instead of
    // claiming a channel delivery that never happened.
    // PHASE-2 T5: `held` is the one outcome with no door to observe it — the whole
    // content of the event is that NO transport was reached. It is recorded through a
    // named entry point rather than by a caller pretending to be a door. This is the
    // 3:32 AM class the `no-outreach-without-inbound` scenario pins: a user-facing
    // outbound on a turn with no inbound and no waiting human is HELD, never delivered.
    recordedId(recordHeld(
      {
        agentId, tool: 'auto-route', channel: 'dashboard',
        conversationId: turnCtx.root?.conversationId ?? null,
      },
      // The held row carries the ROOT READ that produced it, not a restatement of the
      // symptom: "no affirmative root" is the rule, and a reader of this ledger can now
      // tell a hold apart from a push that had one.
      describeOutboundRoot(routeRoot),
    ), 'v2: settled-context hold', { agentId, turnNumber });
    persistRoutingMarker('held in dashboard: no active conversation');
    logger.warn('settled-context hold: withheld auto-route channel push (no affirmative root); reply stays visible in dashboard', {
      agentId, turnNumber, destination, presence: presenceNow,
      outboundRoot: routeRoot.root,
    }, agentId);
  } else if (destination === 'imessage' && !state.repliedToCounterpartyThisTurn.imessage && isImessageConfigured()) {
    // Label the badge with the recipient the bridge ACTUALLY delivered
    // to, never a hardcoded default. If the send was suppressed (sender
    // no longer authorized, empty body), skip the marker entirely so we
    // don't claim a delivery that didn't happen.
    // Route to THIS turn's counterparty (stable). counterparty.senderId is the
    // iMessage address for a human iMessage turn; null (proactive/away) lets
    // the bridge fall back to the owner.
    const imRecipient = counterparty.kind === 'user' && counterparty.channel === 'imessage' ? counterparty.senderId : undefined;
    // C8: this reply reached iMessage EITHER because the turn's counterparty is an
    // iMessage contact (imRecipient set → reply to them) OR because the away-override
    // promoted a dashboard/proactive turn to iMessage to reach the OWNER (imRecipient
    // undefined). In the latter case the send is owner-bound by definition, flag it
    // so the bridge routes to the owner, never to a contact (the "owner's reply
    // texted to a contact" bug class).
    const ownerBound = imRecipient === undefined;
    const replyText = state.lastAssistantTextForIM;
    // PHASE-2 T5: the reply-destination resolver DECLARES who it is answering; the
    // bridge door records whether the send landed. A suppressed or failed push now
    // produces an honest row instead of nothing at all.
    const delivered = await withOutboundAsync(
      {
        agentId, tool: 'auto-route', channel: 'imessage',
        recipientId: imRecipient ?? null,
        conversationId: turnCtx.root?.conversationId ?? null,
      },
      async () => {
        const d = sendResponseViaIMessage(replyText, agentId, imRecipient, ownerBound);
        // C26 tier 3: the engine iMessage auto-route is honestly
        // UNVERIFIABLE (AppleScript/imsg exit code only). Write an
        // exit-code receipt so PM/the user story never pretend delivery
        // was confirmed. Tier 3 imposes no new gate requirement.
        //
        // PHASE-2 T5: the receipt is written INSIDE the scope, deliberately. It was
        // one statement below, outside it, and that one statement was the difference
        // between `deliveries.receipt_id` being populated and being another
        // written-only column — the exact half-closure the Phase-1 exit named. Caught
        // by measuring the live ledger after the first targeted run (0 of 119 linked),
        // not by reading the code.
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
        textLength: state.lastAssistantTextForIM.length,
      }, agentId);
    } else {
      logger.info('v2.7.23: iMessage auto-reply suppressed (no valid recipient)', {
        agentId,
        inboundChannel: state.inboundChannel,
      }, agentId);
    }
  } else if (destination === 'teams' && !state.repliedToCounterpartyThisTurn.teams && state.inboundContext?.chatId) {
    // v2.7.24, Teams reply routing. Inbound Teams DM → reply
    // auto-routes back to the same chat_id via teams_send_message.
    // We invoke executeTool with a synthetic ToolCall so the
    // existing dispatcher handles auth, retries, audit logging.
    // Group chats stay 'message_tool' per the resolver (inbound
    // context populates chatType='group' for those), so this only
    // fires for DM-style Teams chats.
    try {
      const tc: ToolCall = {
        id: uuidv4(),
        name: 'teams_send_message',
        arguments: {
          chat_id: state.inboundContext.chatId,
          message: state.lastAssistantTextForIM,
        },
      };
      const result = await withOutboundAsync(
        {
          agentId, tool: 'auto-route', channel: 'teams',
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
          textLength: state.lastAssistantTextForIM.length,
        }, agentId);
      }
    } catch (err) {
      logger.warn('v2.7.24: teams auto-reply crashed', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  } else if (destination === 'email' && !state.repliedToCounterpartyThisTurn.email && state.inboundContext?.emailMessageId) {
    // v2.7.24, email reply routing. Only fires when the inbound
    // was a "Re:" from a known safe-sender (set in preflight). For
    // those, the model's terminal text is sent as an in-thread
    // reply via outlook_reply (Outlook) or gmail_reply (Gmail).
    // Random new-email notifications keep the existing "agent
    // decides whether to surface" flow, they get inboundChannel=
    // 'dashboard', not 'email'.
    const toolName = state.inboundContext.emailService === 'gmail' ? 'gmail_reply' : 'outlook_reply';
    try {
      const tc: ToolCall = {
        id: uuidv4(),
        name: toolName,
        arguments: {
          message_id: state.inboundContext.emailMessageId,
          body: state.lastAssistantTextForIM,
          // B-1 (comms-audit): reply FROM the same mailbox that received it.
          // Omitted before, so with 2+ agent accounts the reply silently failed.
          ...(state.inboundContext.emailAccount ? { account: state.inboundContext.emailAccount } : {}),
        },
      };
      const result = await withOutboundAsync(
        {
          agentId, tool: 'auto-route', channel: 'email',
          recipientId: state.inboundContext.recipientAddress ?? null,
          provider: state.inboundContext.emailService ?? null,
          conversationId: turnCtx.root?.conversationId ?? null,
        },
        () => executeTool(agentId, tc),
      );
      if (result.kind !== 'applied') {
        logger.warn('v2.7.24: email auto-reply failed', { agentId, tool: toolName, why: result.reason, error: result.result.content }, agentId);
      } else {
        // Prefer the recipient address (the person we replied to) so the
        // badge reads "to <addr> via email"; fall back to the thread
        // subject form when the address isn't known (recipient stays null,
        // badge falls back to "sent via email reply").
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
          textLength: state.lastAssistantTextForIM.length,
        }, agentId);
      }
    } catch (err) {
      logger.warn('v2.7.24: email auto-reply crashed', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  } else if (destination === 'phone' && !state.repliedToCounterpartyThisTurn.phone && state.inboundContext?.phoneCallSid) {
    // v2.9.18 - phone call reply routing. The agent just emitted
    // text in response to a caller utterance during an active
    // phone call. Push the text into the call's TTS pipeline so
    // it gets spoken back over the same call.
    // v2.9.23, if streaming TTS already flushed sentences via
    // onChunk above, we ONLY queue whatever tail remains in
    // turnCtx.phoneStreamBuffer. If nothing was streamed (e.g. the
    // model returned in one shot, or onChunk never fired) we
    // fall back to the original one-shot push so we never
    // silently drop the reply.
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
        // Streaming path took care of the body. Flush the
        // remaining tail (final sentence without trailing
        // punctuation-plus-whitespace) if any.
        const tail = turnCtx.phoneStreamBuffer.trim();
        if (tail) {
          // PHASE-2 T5: the phone door records per UTTERANCE, so the whole reply is
          // declared as one scope and its sentences fold into one row. A reply spoken
          // in four sentences is one thing the caller heard.
          await withOutboundAsync(
            {
              agentId, tool: 'auto-route', channel: 'phone',
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
          totalTextLength: state.lastAssistantTextForIM.length,
        }, agentId);
      } else {
        const phoneText = state.lastAssistantTextForIM;
        await withOutboundAsync(
          {
            agentId, tool: 'auto-route', channel: 'phone',
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
          textLength: state.lastAssistantTextForIM.length,
        }, agentId);
      }
    } catch (err) {
      logger.warn('v2.9.18: phone auto-reply crashed', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  } else if (destination === 'sms' && !state.repliedToCounterpartyThisTurn.sms && state.inboundContext?.smsFromNumber) {
    // v2.9.18 - SMS reply routing. Inbound SMS from a known
    // sender → agent's terminal text auto-routes back via
    // Twilio sendSms to the original sender. From-number is
    // the same Twilio number that received the inbound (so
    // the thread looks continuous on the recipient's phone).
    try {
      const { sendSms } = await import('../../../../twilio/client.js');
      const { getDefaultFromNumber } = await import('../../../../twilio/auth.js');
      const fromNumber = state.inboundContext.smsToNumber ?? getDefaultFromNumber();
      if (!fromNumber) {
        logger.warn('v2.9.18: sms auto-reply skipped - no from-number available', { agentId }, agentId);
      } else {
        const smsTo = state.inboundContext.smsFromNumber;
        const smsText = state.lastAssistantTextForIM;
        const r = await withOutboundAsync(
          {
            agentId, tool: 'auto-route', channel: 'sms', recipientId: smsTo,
            conversationId: turnCtx.root?.conversationId ?? null,
          },
          async () => {
            const res = await sendSms(smsTo, smsText, fromNumber);
            // C26 (FA-C3): the SMS auto-route was the only durable-channel auto-send
            // without a receipt, so a PM/user story could not prove it happened. Write a
            // tier-1 receipt exactly like the sms_send TOOL and the iMessage auto-route:
            // verified on the Twilio SID (provider-id), else http-status. This cannot block a
            // completion, the gate only demands receipts for turns that ran a send TOOL.
            // PHASE-2 T5: inside the scope, so the receipt links to the delivery row.
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
            textLength: state.lastAssistantTextForIM.length,
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
