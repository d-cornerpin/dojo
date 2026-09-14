// ════════════════════════════════════════════════════════════════════════════
// WHICH CHANNEL A TOOL REACHES A HUMAN ON (UX-ACCESS A1).
//
// The census named the surface precisely and it is already build-checked:
// `agent/sensei-policy.ts`'s `SEND_TO_PEOPLE` is "the entire 'reaches a real
// person on an owner channel' surface", and `tools/__tests__/tool-list-
// conformance.test.ts` fails the release gate when a tool carries
// `reachesPeople: true` and is not on that list, or the reverse. So the channel
// map is DERIVED FROM THAT SET rather than hand-listed a second time: a new send
// tool cannot be added without landing on the list, and a name on the list that
// this file cannot place is a red test, not a silently ungated door.
//
// The mapping itself is by family, because that is what the names encode —
// `gmail_*`/`outlook_*` sends are email, `teams_*` sends are Teams, and the
// three Twilio verbs split by prefix. `user_` twins reach the OWNER's account on
// the same channel, so they map identically; which MAILBOX they touch is the
// integration grant's question, not the channel's.
// ════════════════════════════════════════════════════════════════════════════

import type { AccessChannel } from '@dojo/shared';
import { SEND_TO_PEOPLE } from '../sensei-policy.js';

/** The family rules, in order. First match wins. */
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

/**
 * The owner-channel tools, each with the channel it reaches a human on.
 *
 * Built once from `SEND_TO_PEOPLE`, so this table can never name a tool that is
 * not on the build-checked send surface — the second clause of the census test
 * asserts exactly that, and it is true by construction here.
 */
export const CHANNEL_TOOLS: Readonly<Record<string, AccessChannel>> = Object.freeze(
  Object.fromEntries(
    SEND_TO_PEOPLE.map((n) => [n, classify(n)] as const).filter(
      (e): e is readonly [string, AccessChannel] => e[1] !== null,
    ),
  ),
);

/**
 * The channel this tool reaches a human on, or `null` when it reaches nobody.
 *
 * `null` is not "allowed": it means the channel grant has no opinion, and the
 * tool's other gates (the manifest, the integration tier, the PM wall) answer as
 * they always did. Only a tool on the owner-channel surface consults a channel
 * grant, which is what keeps A1 from inventing refusals for `send_to_agent`,
 * `show_to_user` or a dashboard reply.
 */
export function channelForTool(name: string): AccessChannel | null {
  return CHANNEL_TOOLS[name] ?? null;
}
