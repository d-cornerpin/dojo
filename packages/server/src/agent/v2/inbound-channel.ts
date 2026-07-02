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

  // A-3 (comms-audit): a Teams GROUP message must NOT earn an auto-reply into the
  // group. Group replies are explicit-tool-only (the agent decides to call
  // teams_send_message). Downgrade to a dashboard notice so the agent reads it but
  // the engine never auto-routes a reply to every group ping. This was documented in
  // three comments (channel-auth header, state.ts, loop.ts) but enforced NOWHERE.
  // DM Teams chats keep their routed reply context below.
  if (meta.channel === 'teams' && meta.chatType === 'group') {
    return { inboundChannel: 'dashboard', inboundContext: null };
  }

  // C10: re-validate the sender at RESOLVE time for the auto-reply channels, mirroring
  // the prose branches (which DO recheck). resolveFromMeta previously trusted only the
  // persisted `meta.authorized` flag — but every modern producer stamps inbound_meta, so
  // the prose fallbacks that recheck are dead in practice, and a row stamped
  // authorized:true whose sender was LATER removed from the safe list still earned an
  // auto-reply on SMS/Teams-DM/email (only iMessage re-validates at send). Downgrade to a
  // dashboard notice on failure so the agent still reads it but the engine never
  // auto-routes a reply to an unauthorized/removed sender (inv 5). (iMessage stays as-is —
  // it re-validates at send in sendResponseViaIMessage.)
  if (meta.channel === 'sms' || meta.channel === 'teams' || meta.channel === 'email') {
    const slot = meta.accountKind === 'user' ? 'user' : 'agent';
    const senderKey = meta.smsFromNumber ?? meta.sender ?? meta.recipientAddress ?? '';
    if (!isSenderAuthorized(meta.channel, senderKey, slot, meta.emailService ? { emailService: meta.emailService } : undefined)) {
      return { inboundChannel: 'dashboard', inboundContext: null };
    }
  }

  const context: ChannelInboundContext = {
    recipientAddress: meta.recipientAddress,
    emailMessageId: meta.emailMessageId,
    emailService: meta.emailService,
    emailSubject: meta.emailSubject,
    emailAccount: meta.emailAccount, // B-1: reply from the SAME mailbox
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
    // A-3 (comms-audit): authorized DM Teams chats auto-route; GROUP chats do NOT
    // (no auto-reply into the group) — they fall through to the dashboard notice.
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
    // sms-inbound.ts gates on the safe-sender list before emitting the
    // `[SOURCE: SMS FROM` tag (unknown senders get `[SOURCE: SMS NOTIFICATION`
    // and fall through to dashboard), so anything tagged here was authorized AT
    // TAG TIME.
    // N-5 (comms-audit): re-run the safe-sender check at RESOLVE time anyway, the
    // same way the Teams (above) and email paths do. The tag is durable prose; a
    // number removed from the SMS safe-list after the row was written (or an old/
    // replayed row) would otherwise still resolve as an authorized SMS reply target
    // and the agent would auto-reply to a sender it's no longer allowed to. If the
    // recheck fails, route to dashboard as a notification instead (inv 5: never act
    // on an unauthorized sender's behalf).
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
