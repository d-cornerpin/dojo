// The helpers' channel grants: each name of `SEND_TO_PEOPLE` takes its channel from the shared people-tools table.

import { peopleToolOf, type AccessChannel } from '@dojo/shared';
import { SEND_TO_PEOPLE } from '../sensei-policy.js';

// The table says `phone` for the phone channel; the grants call it `voice`.
export const CHANNEL_TOOLS: Readonly<Record<string, AccessChannel>> = Object.freeze(
  Object.fromEntries(SEND_TO_PEOPLE.flatMap((name) => {
    const channel = peopleToolOf(name)?.channel;
    return channel ? [[name, channel === 'phone' ? 'voice' : channel] as const] : [];
  })),
);

/** null means the tool reaches nobody: the channel grant has no opinion and no refusal is invented. */
export function channelForTool(name: string): AccessChannel | null {
  return CHANNEL_TOOLS[name] ?? null;
}
