// Channel badge presentation: maps a ChannelKind (+ sender/recipient) to the emoji and label
// on the inbound/outbound chips. ONE source so every chat page renders identical badges;
// the parsing lives in @dojo/shared, this is the dashboard-side wording.
import { unfenceExternal, type ChannelKind, type OutboundRoutingMatch } from '@dojo/shared';

/** The fence is for the agent; the owner sees fenced text as it arrived. The ONE dashboard strip. */
export function withoutFence(content: string): string {
  return unfenceExternal(content);
}

export { inboundSenderName } from './inbound-sender-name';   // the badge's sender name

const CHANNEL_EMOJI: Record<ChannelKind, string> = {
  imessage: '\u{1F4AC}',     // speech balloon
  phone: '\u{260E}\u{FE0F}', // telephone
  sms: '\u{1F4F1}',          // mobile phone
  teams: '\u{1F4DD}',        // memo
  email: '\u{2709}\u{FE0F}', // envelope
};

const CHANNEL_NAME: Record<ChannelKind, string> = {
  imessage: 'iMessage',
  phone: 'phone call',
  sms: 'SMS',
  teams: 'Teams',
  email: 'email',
};

export interface ChannelBadge {
  emoji: string;
  label: string;
}

// Drop a "(unknown)" name so a badge reads "via phone call", not "from (unknown) via phone call".
function cleanName(name: string | null): string | null {
  if (!name) return null;
  const t = name.trim();
  return t && t !== '(unknown)' ? t : null;
}

export function inboundBadge(channel: ChannelKind, sender: string | null): ChannelBadge {
  const who = cleanName(sender);
  const name = CHANNEL_NAME[channel];
  return {
    emoji: CHANNEL_EMOJI[channel],
    label: who ? `from ${who} via ${name}` : `via ${name}`,
  };
}

// Outbound: the reply went out via this channel ("to X via iMessage"), or, not (yet) delivered, where it
// stands. With no recipient, the channel alone; an email reply says "sent via email reply".
export function outboundBadge(channel: ChannelKind, recipient: string | null, state: OutboundRoutingMatch['state'] = null): ChannelBadge {
  const who = cleanName(recipient);
  const name = CHANNEL_NAME[channel];
  const to = who ? ` to ${who}` : '';
  const why = state?.reason ? `: ${state.reason}` : '';
  const delivered = who ? `to ${who} via ${name}` : channel === 'email' ? 'sent via email reply' : `sent via ${name}`;
  const label = !state ? delivered
    : state.kind === 'sending' ? `sending by ${name}${to}`
    : state.kind === 'not delivered' ? `not delivered by ${name}${to}${why}`
    : `not sent${to}${why}`;
  return { emoji: CHANNEL_EMOJI[channel], label };
}
