// ════════════════════════════════════════
// Inbound Channel Resolver (v3.0.9)
//
// The ONE place the engine decides which channel a turn was triggered from
// and how to address the reply. The reply-destination resolver then routes
// the model's terminal text back to that channel.
//
// Three sources, in priority order:
//
//  1. VOICE — a dashboard turn whose message row carries source='voice' is
//     in-person speech. It is its own first-class channel: the reply is
//     spoken back via TTS and is NEVER diverted to iMessage by the away
//     override (a person talking to you out loud doesn't get a text back).
//
//  2. STRUCTURED METADATA — messages.inbound_meta (JSON, @dojo/shared
//     InboundMeta) stamped by the channel producer at injection time. This
//     is the reliable path: routing reads structured fields, not prose, so
//     re-wording a notification can't break it. `authorized === false` means
//     the producer judged this not an auto-reply (unknown sender, or a
//     user-owned account) → treat as a dashboard notification.
//
//  3. PROSE FALLBACK — for messages with no metadata (older rows, or a
//     producer not yet migrated), parse the [SOURCE: ...] marker the way the
//     engine always did. Behavior-preserving safety net; authorization runs
//     through the same shared isSenderAuthorized check as everything else.
// ════════════════════════════════════════
import type { InboundMeta } from '@dojo/shared';
import type { ChannelInboundContext } from './state.js';
import { isSenderAuthorized } from './channel-auth.js';
import { getInboundSenderFor } from '../../services/imessage-bridge.js';
import { getDb } from '../../db/connection.js';

/**
 * Stamp structured routing metadata onto an inbound message row. Channel
 * producers call this right after inserting the user message (they already
 * hold its id). Non-fatal on failure: the engine falls back to prose
 * parsing, so a stamp failure degrades to the old behavior, never a crash.
 */
export function recordInboundMeta(messageId: string, meta: InboundMeta): void {
  try {
    getDb()
      .prepare('UPDATE messages SET inbound_meta = ? WHERE id = ?')
      .run(JSON.stringify(meta), messageId);
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
  /** The triggering user message content (may be null when there is none). */
  content: string | null;
  /** The triggering message row's `source` column ('voice' | null | ...). */
  source: string | null;
  /** The triggering message row's `inbound_meta` column (raw JSON or null). */
  inboundMeta: string | null;
}

export function resolveInbound(args: ResolveInboundArgs): ResolvedInbound {
  const { agentId, content, source, inboundMeta } = args;

  // ── 1. Voice: in-person speech is its own channel. ──
  if (source === 'voice') {
    return { inboundChannel: 'voice', inboundContext: null };
  }

  // ── 2. Structured metadata: the reliable path. ──
  if (inboundMeta) {
    const fromMeta = resolveFromMeta(inboundMeta);
    if (fromMeta) return fromMeta;
    // Malformed metadata → fall through to prose parsing rather than dropping
    // the turn to dashboard silently.
  }

  // ── 3. Prose fallback: parse the [SOURCE: ...] marker. ──
  return resolveFromProse(agentId, content);
}

// ── Structured-metadata path ──
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

  // Unauthorized (unknown sender, or a user-owned account) → notification
  // flow. The agent still reads the message; no auto-route fires.
  if (meta.authorized === false) {
    return { inboundChannel: 'dashboard', inboundContext: null };
  }

  const context: ChannelInboundContext = {
    recipientAddress: meta.recipientAddress,
    emailMessageId: meta.emailMessageId,
    emailService: meta.emailService,
    emailSubject: meta.emailSubject,
    chatId: meta.chatId,
    chatType: meta.chatType,
    smsFromNumber: meta.smsFromNumber,
    smsToNumber: meta.smsToNumber,
    phoneCallSid: meta.phoneCallSid,
    phoneFromNumber: meta.phoneFromNumber,
  };
  return { inboundChannel: meta.channel, inboundContext: context };
}

// ── Prose fallback (behavior-preserving move of the legacy engine logic) ──
function resolveFromProse(agentId: string, content: string | null): ResolvedInbound {
  const triggeredByIMessage = content?.includes('[SOURCE: IMESSAGE FROM') ?? false;

  if (triggeredByIMessage) {
    const pendingSender = getInboundSenderFor(agentId);
    return {
      inboundChannel: 'imessage',
      inboundContext: { recipientAddress: pendingSender ?? undefined, chatType: 'dm' },
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
    // Teams is an agent-kind channel today (the watcher is agent-only); the
    // shared check applies the agent-kind gate so it stays correct if a
    // user-Teams watcher is ever added.
    if (isSenderAuthorized('teams', senderAddress, 'agent') && chatIdMatch?.[1]) {
      return {
        inboundChannel: 'teams',
        inboundContext: {
          chatId: chatIdMatch[1],
          chatType: isGroup ? 'group' : 'dm',
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
    // Auto-route the reply back via email ONLY when mail came to the AGENT's
    // own mailbox from a known contact, and we have a Message ID to reply
    // against. No "Re:" requirement — a safe sender writing to the agent
    // (new thread or reply) is a direct message and gets a reply.
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
    // Live phone call utterance. The agent is already on the call, so the
    // reply is spoken back via TTS to whoever is on the line — no
    // safe-sender gate (you answered the phone).
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
    // sms-inbound.ts already gates on the safe-sender list before emitting
    // the `[SOURCE: SMS FROM` tag (unknown senders get `[SOURCE: SMS
    // NOTIFICATION` and fall through to dashboard), so anything tagged here
    // is from a known sender.
    const fromMatch = content.match(/\[SOURCE: SMS FROM ([^\]]+)\]/);
    const toMatch = content.match(/^To:\s*(\S+)/im);
    if (fromMatch?.[1]) {
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
