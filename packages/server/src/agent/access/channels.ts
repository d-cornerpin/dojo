// DERIVED from `SEND_TO_PEOPLE`, the build-checked send surface: a new send tool lands there or the
// conformance gate is red, so a channel door cannot be dodged by forgetting a second hand-list.

import type { AccessChannel } from '@dojo/shared';
import { SEND_TO_PEOPLE } from '../sensei-policy.js';

/** Family rules, first match wins; the `user_` twin is stripped before matching, so both map alike. */
const FAMILIES: ReadonlyArray<{ test: (base: string) => boolean; channel: AccessChannel }> = [
  { test: (n) => n.startsWith('imessage_'), channel: 'imessage' },
  { test: (n) => n.startsWith('sms_'), channel: 'sms' },
  { test: (n) => n.startsWith('voice_call'), channel: 'voice' },
  { test: (n) => n.startsWith('teams_'), channel: 'teams' },
  { test: (n) => n.startsWith('gmail_') || n.startsWith('outlook_'), channel: 'email' },
];

function classify(name: string): AccessChannel | null {
  const base = name.startsWith('user_') ? name.slice('user_'.length) : name;
  for (const f of FAMILIES) if (f.test(base)) return f.channel;
  return null;
}

export const CHANNEL_TOOLS: Readonly<Record<string, AccessChannel>> = Object.freeze(
  Object.fromEntries(
    SEND_TO_PEOPLE.map((n) => [n, classify(n)] as const).filter(
      (e): e is readonly [string, AccessChannel] => e[1] !== null,
    ),
  ),
);

/** null means the tool reaches nobody: the channel grant has no opinion and no refusal is invented. */
export function channelForTool(name: string): AccessChannel | null {
  return CHANNEL_TOOLS[name] ?? null;
}
