// The one place the engine decides which channel triggered a turn and how to address the reply. Priority:
// voice (spoken back, never diverted to iMessage), structured inbound_meta (routing reads fields, not prose),
// then the [SOURCE: ...] prose marker for rows without metadata. SMS, Teams and email senders are rechecked
// with isSenderAuthorized at resolve time; iMessage re-validates at send instead.
import type { InboundMeta } from '@dojo/shared';
import type { ChannelInboundContext } from './state.js';
import { isSenderAuthorized, mayAnswer } from './channel-auth.js';
import { stampInboundMeta } from '../../memory/message-store.js';

/** Stamp structured routing metadata on an inbound row; producers call it right after inserting the message.
 *  Best-effort: on failure the engine falls back to prose parsing. */
export function recordInboundMeta(messageId: string, meta: InboundMeta): void {
  try {
    stampInboundMeta(messageId, JSON.stringify(meta));
  } catch {
    // best-effort
  }
}

export type InboundChannel =
  | 'imessage'
  | 'teams'
  | 'email'
  | 'sms'
  | 'phone'
  | 'voice'
  | 'dashboard'
  | null;

export interface ResolvedInbound {
  inboundChannel: InboundChannel;
  inboundContext: ChannelInboundContext | null;
}

export interface ResolveInboundArgs {
  agentId: string;
  content: string | null;
  /** The triggering message row's stamped `channel` ('voice' | 'imessage' | ... | null). */
  channel: string | null;
  inboundMeta: string | null;
}

export function resolveInbound(args: ResolveInboundArgs): ResolvedInbound {
  const { agentId, content, channel, inboundMeta } = args;

  if (channel === 'voice') {
    return { inboundChannel: 'voice', inboundContext: null };
  }

  if (inboundMeta) {
    const fromMeta = resolveFromMeta(inboundMeta);
    if (fromMeta) return fromMeta;
    // Malformed metadata falls through to prose parsing rather than silently dropping to dashboard.
  }

  return resolveFromProse(agentId, content);
}

function resolveFromMeta(raw: string): ResolvedInbound | null {
  let meta: InboundMeta;
  try {
    meta = JSON.parse(raw) as InboundMeta;
  } catch {
    return null;
  }
  if (!meta || typeof meta !== 'object' || !meta.channel) return null;

  // Voice and dashboard never carry a routed reply context.
  if (meta.channel === 'voice') return { inboundChannel: 'voice', inboundContext: null };
  if (meta.channel === 'dashboard') return { inboundChannel: 'dashboard', inboundContext: null };

  // Unauthorized (unknown sender, or a user-owned account): a notification the agent reads, no auto-route.
  if (meta.authorized === false) {
    return { inboundChannel: 'dashboard', inboundContext: null };
  }

  // A Teams group message never earns an auto-reply into the group (replies there are explicit-tool-only):
  // downgrade to a dashboard notice. Teams DMs keep their routed reply context.
  if (meta.channel === 'teams' && meta.chatType === 'group') {
    return { inboundChannel: 'dashboard', inboundContext: null };
  }

  // Recheck the sender at resolve time, so a sender removed from the safe list after the row was stamped
  // gets a dashboard notice, not an auto-reply. iMessage re-validates at send.
  if (meta.channel === 'sms' || meta.channel === 'teams' || meta.channel === 'email') {
    const slot = meta.accountKind === 'user' ? 'user' : 'agent';
    const senderKey = meta.smsFromNumber ?? meta.sender ?? meta.recipientAddress ?? '';
    if (!mayAnswer(meta.channel, senderKey, slot, { emailService: meta.emailService, fromOwner: meta.relation === 'owner' })) {
      return { inboundChannel: 'dashboard', inboundContext: null };
    }
  }

  const context: ChannelInboundContext = {
    // An email's watcher stamps the writer as `sender` with no separate reply address, so the reply goes to it.
    recipientAddress: meta.recipientAddress ?? (meta.channel === 'email' ? (meta.sender ?? undefined) : undefined),
    emailMessageId: meta.emailMessageId,
    emailService: meta.emailService,
    emailSubject: meta.emailSubject,
    emailAccount: meta.emailAccount, // reply from the same mailbox
    chatId: meta.chatId,
    chatType: meta.chatType,
    teamsAccount: meta.teamsAccount,
    smsFromNumber: meta.smsFromNumber,
    smsToNumber: meta.smsToNumber,
    phoneCallSid: meta.phoneCallSid,
    phoneFromNumber: meta.phoneFromNumber,
  };
  return { inboundChannel: meta.channel, inboundContext: context };
}

function resolveFromProse(agentId: string, content: string | null): ResolvedInbound {
  const triggeredByIMessage = content?.includes('[SOURCE: IMESSAGE FROM') ?? false;

  if (triggeredByIMessage) {
    // No recipient guess on the prose path: a row without inbound_meta has no structural sender identity, and
    // an unresolvable reply falls to the owner default at the bridge.
    return {
      inboundChannel: 'imessage',
      inboundContext: { chatType: 'dm' },
    };
  }

  if (content?.includes('[SOURCE: TEAMS MESSAGE FROM')) {
    // Auto-route only when the sender is on the Teams safe-sender allowlist.
    const chatIdMatch = content.match(/Chat ID:\s*([^\s\]]+)/i);
    const chatTypeMatch = content.match(/Chat:[^()\n]*\(([^)]+)\)/i);
    const isGroup = chatTypeMatch?.[1]?.toLowerCase().includes('group') ?? false;
    const senderHeader = content.match(/\[SOURCE: TEAMS MESSAGE FROM ([^\]]+)\]/i);
    const senderRaw = senderHeader?.[1] ?? '';
    const emailMatch =
      senderRaw.match(/<([^>]+)>/) ?? senderRaw.match(/\(([^)]+)\)/) ?? senderRaw.match(/(\S+@\S+)/);
    const senderAddress = emailMatch?.[1]?.toLowerCase() ?? '';
    // Teams is agent-kind (the watcher is agent-only); only authorized DM chats auto-route, groups get a notice.
    if (isSenderAuthorized('teams', senderAddress, 'agent') && chatIdMatch?.[1] && !isGroup) {
      return {
        inboundChannel: 'teams',
        inboundContext: {
          chatId: chatIdMatch[1],
          chatType: 'dm',
          recipientAddress: senderAddress,
        },
      };
    }
    return { inboundChannel: 'dashboard', inboundContext: null };
  }

  if (
    content?.includes('[SOURCE: OUTLOOK NOTIFICATION') ||
    content?.includes('[SOURCE: GMAIL NOTIFICATION')
  ) {
    // Auto-route by email only for mail to the agent's own mailbox from a known contact with a Message ID; a
    // safe sender writing to the agent, new thread or reply, gets a reply.
    const subjectMatch = content.match(/^Subject:\s*(.+)$/im);
    const fromMatch = content.match(/^From:\s*(.+)$/im);
    const messageIdMatch = content.match(/^Message ID:\s*(\S+)/im);
    const isOutlook = content.includes('[SOURCE: OUTLOOK NOTIFICATION');
    const emailService: 'outlook' | 'gmail' = isOutlook ? 'outlook' : 'gmail';
    // The parenthesized suffix names the mailbox KIND ("agent's …"/"user's …").
    const slotMatch = content.match(
      /\[SOURCE: (?:GMAIL|OUTLOOK) NOTIFICATION[^()]*\(([^)]+)\)\]/i,
    );
    const inboundSlot: 'agent' | 'user' = slotMatch?.[1]?.toLowerCase().includes('user')
      ? 'user'
      : 'agent';
    const subject = subjectMatch?.[1]?.trim() ?? '';
    const fromRaw = fromMatch?.[1]?.trim() ?? '';
    const emailMatch = fromRaw.match(/<([^>]+)>/) ?? fromRaw.match(/(\S+@\S+)/);
    const fromAddress = emailMatch?.[1]?.toLowerCase() ?? '';
    const authorized = isSenderAuthorized('email', fromAddress, inboundSlot, { emailService });
    if (authorized && messageIdMatch?.[1]) {
      return {
        inboundChannel: 'email',
        inboundContext: {
          emailMessageId: messageIdMatch[1],
          emailService,
          emailSubject: subject,
          recipientAddress: fromAddress,
        },
      };
    }
    return { inboundChannel: 'dashboard', inboundContext: null };
  }

  if (content?.includes('[SOURCE: PHONE CALL FROM')) {
    // Live phone call: the reply is spoken back to whoever is on the line, so no safe-sender gate.
    const fromMatch = content.match(/\[SOURCE: PHONE CALL FROM ([^\]]+)\]/);
    const callSidMatch = content.match(/Call SID:\s*(\S+)/);
    if (fromMatch?.[1] && callSidMatch?.[1]) {
      return {
        inboundChannel: 'phone',
        inboundContext: {
          phoneCallSid: callSidMatch[1].trim(),
          phoneFromNumber: fromMatch[1].trim(),
          recipientAddress: fromMatch[1].trim(),
        },
      };
    }
    return { inboundChannel: 'dashboard', inboundContext: null };
  }

  if (content?.includes('[SOURCE: SMS FROM')) {
    // sms-inbound.ts tags only safe senders as SMS FROM, but the sender is rechecked here so a number removed
    // from the safe list after the row was written gets a dashboard notice, not an auto-reply.
    const fromMatch = content.match(/\[SOURCE: SMS FROM ([^\]]+)\]/);
    const toMatch = content.match(/^To:\s*(\S+)/im);
    if (fromMatch?.[1] && isSenderAuthorized('sms', fromMatch[1].trim(), 'agent')) {
      return {
        inboundChannel: 'sms',
        inboundContext: {
          smsFromNumber: fromMatch[1].trim(),
          smsToNumber: toMatch?.[1]?.trim(),
          recipientAddress: fromMatch[1].trim(),
        },
      };
    }
    return { inboundChannel: 'dashboard', inboundContext: null };
  }

  if (content) {
    return { inboundChannel: 'dashboard', inboundContext: null };
  }

  return { inboundChannel: null, inboundContext: null };
}
