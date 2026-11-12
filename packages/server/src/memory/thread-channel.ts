
const CHANNEL_WORDS: Record<string, string> = {
  dashboard: 'the dashboard', imessage: 'iMessage', sms: 'SMS', teams: 'Teams', email: 'email', voice: 'voice',
};

/** The owner's bare label gains " via <Channel>"; done here, not in `conversationLabel` (stored text). */
export function withChannel(label: string, channel: string): string {
  if (label.endsWith(`(${channel})`)) return label;
  return `${label} via ${CHANNEL_WORDS[channel] ?? channel}`;
}

