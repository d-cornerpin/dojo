// Channel badge presentation: maps a ChannelKind (+ sender/recipient) to the
// emoji + label shown on inbound/outbound channel chips. ONE source so every
// chat page (Chat, AgentDetail) renders identical badges and the wording cannot
// drift. The PARSING lives in @dojo/shared (parseInboundChannel /
// parseOutboundRouting); this is the dashboard-side wording. See
// DOJO-CHAT-VISIBILITY-PLAN.md §3 and V3 (channel-badge correctness).
import type { ChannelKind } from '@dojo/shared';

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

// "(unknown)" callers/recipients carry no useful name; drop them so a badge
// reads "via phone call" rather than "from (unknown) via phone call".
function cleanName(name: string | null): string | null {
  if (!name) return null;
  const t = name.trim();
  return t && t !== '(unknown)' ? t : null;
}

// Inbound: a person reached the agent via this channel ("from X via iMessage").
export function inboundBadge(channel: ChannelKind, sender: string | null): ChannelBadge {
  const who = cleanName(sender);
  const name = CHANNEL_NAME[channel];
  return {
    emoji: CHANNEL_EMOJI[channel],
    label: who ? `from ${who} via ${name}` : `via ${name}`,
  };
}

// Outbound: the agent's reply was routed out via this channel ("to X via
// iMessage"). Every channel shows the recipient when one is known (including
// email, whose recipient is the address we replied to). When no recipient is
// resolvable (an email REPLY badged by thread only, or a suppressed send), fall
// back to the channel-only wording, "sent via email reply" for email to match
// the prior UX, "sent via <channel>" otherwise.
export function outboundBadge(channel: ChannelKind, recipient: string | null): ChannelBadge {
  const who = cleanName(recipient);
  const name = CHANNEL_NAME[channel];
  return {
    emoji: CHANNEL_EMOJI[channel],
    label: who
      ? `to ${who} via ${name}`
      : channel === 'email'
        ? 'sent via email reply'
        : `sent via ${name}`,
  };
}
