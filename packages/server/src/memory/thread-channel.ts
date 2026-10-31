// memory/thread-channel.ts — which channel an other-thread row is on (T282).

/** What the owner calls each channel; an unknown channel prints as its own id, never blank. */
const CHANNEL_WORDS: Record<string, string> = {
  dashboard: 'the dashboard', imessage: 'iMessage', sms: 'SMS', teams: 'Teams', email: 'email', voice: 'voice',
};

/**
 * T282 (the owner's law: agents always know which channels they use and who they talk to): every row names
 * its channel. Contact labels are born "Name (imessage)" in `conversationLabel` and keep that; the owner's
 * label is the bare name on every channel, so it gains " via <Channel>". Done HERE, where THIS lane's label
 * is born, not in `conversationLabel`: that function also tags summaries and recalled rows, which are
 * stored/prefix-adjacent text this fix must not move.
 */
export function withChannel(label: string, channel: string): string {
  if (label.endsWith(`(${channel})`)) return label;
  return `${label} via ${CHANNEL_WORDS[channel] ?? channel}`;
}

