// ════════════════════════════════════════════════════════════════════════════
// THE WORDS THE PANEL SAYS ABOUT THE OBJECT (UX-ACCESS A6) — pure, no React.
//
// The owner's design asks the folded card to carry a one-line plain-English
// digest of the agent's setup, and each of the five folded rows to carry its own
// state line. All of it is DERIVED from the stored object on every render: there
// is no summary field anywhere, because a stored summary is a second copy of a
// fact and this overhaul exists to end those.
//
// ── WHY IT IS ITS OWN FILE ──
// `access-edits.ts` is the panel's grant ARITHMETIC and its ratchet entry says,
// in three separate raises, "from here this file may only shrink". Reading the
// object and WRITING it back are different jobs: nothing here returns an
// `AccessGrants`, and nothing in there produces a sentence. So the words live
// beside the arithmetic rather than inside it, and neither file grows to hold
// the other's work.
//
// ── THE ONE INPUT THAT IS NOT A GRANT ──
// `runsPrograms` is the permission manifest's `exec_allow`, passed in rather
// than read here, because this module may not learn a second model. It earns its
// place in the digest by being the most consequential thing an agent can hold,
// and a count it disappeared into would be a quieter line than the truth
// deserves.
// ════════════════════════════════════════════════════════════════════════════

import type { AccessChannel, AccessGrants, ProviderGrants } from '@dojo/shared';
import { ACCESS_CHANNELS, channelTierOf, techniqueGrantOf } from '@dojo/shared';

/** The one place a channel has an owner-facing name. */
export const CHANNEL_LABEL: Record<AccessChannel, string> = {
  imessage: 'iMessage', sms: 'Text message (SMS)', voice: 'Phone calls', email: 'Email', teams: 'Microsoft Teams',
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How many tool groups, or `null` for "every group, including future ones". */
const groupCount = (g: AccessGrants): number | null =>
  g.tools.categories === '*' ? null : g.tools.categories.length;

/** Kinds of one provider's accounts this agent may touch. The panel keeps the
 *  KIND level equal to the widest account of that kind (`setAccountLevel`), so
 *  counting kinds is exact for anything the panel has written. */
const providerReach = (p: ProviderGrants): number =>
  (p.agent !== 'none' ? 1 : 0) + (p.user !== 'none' ? 1 : 0);

/** Everything in "What it can reach" that comes from the grants object. */
const connectionCount = (g: AccessGrants): number =>
  (g.integrations.plaud ? 1 : 0)
  + (g.integrations.credentials ? 1 : 0)
  + providerReach(g.integrations.google)
  + providerReach(g.integrations.microsoft);

const grantedChannels = (g: AccessGrants): AccessChannel[] =>
  ACCESS_CHANNELS.filter((c) => channelTierOf(g, c) !== 'none');

/** "you only" / "you and approved contacts" — owner ruling 1's me-vs-others tier
 *  said the way the person reading it would say it. */
const whoPhrase = (g: AccessGrants): string =>
  grantedChannels(g).every((c) => channelTierOf(g, c) === 'owner')
    ? 'you only'
    : 'you and approved contacts';

/** THE FOLDED CARD'S ONE LINE. Built from the STORED object, never the draft, so
 *  a shut card never reports an unsaved edit as if it had been saved. */
export function accessDigest(g: AccessGrants, extra: { runsPrograms: boolean }): string {
  const groups = groupCount(g);
  const reach = grantedChannels(g);
  const connections = connectionCount(g);
  const parts = [
    groups === null ? 'Full tools' : plural(groups, 'tool group'),
    g.channels.master === null
      ? 'talks through your main agent'
      : reach.length === 0 ? 'talks to no one' : `talks to ${whoPhrase(g)}`,
    connections === 0 ? 'no connections' : plural(connections, 'connection'),
  ];
  if (extra.runsPrograms) parts.push('runs programs');
  return parts.join(' · ');
}

/** Row 1 — what it can do. */
export const toolsSummary = (g: AccessGrants): string => {
  const n = groupCount(g);
  return n === null ? 'Full tool access' : plural(n, 'tool group');
};

/** Row 2 — what it can reach. The two folded-in items ride in as booleans. */
export function reachSummary(g: AccessGrants, legacy: { web: boolean; programs: boolean }): string {
  const accounts = providerReach(g.integrations.google) + providerReach(g.integrations.microsoft);
  const parts: string[] = [];
  if (g.integrations.plaud) parts.push('Plaud');
  if (accounts > 0) parts.push(plural(accounts, 'account'));
  if (g.integrations.credentials) parts.push('stored keys');
  if (legacy.web) parts.push('the web');
  if (legacy.programs) parts.push('programs');
  return parts.length === 0 ? 'Nothing' : parts.join(', ');
}

/** Row 3 — who it can talk to. */
export function talkSummary(g: AccessGrants): string {
  if (g.channels.master === null) return 'Through your main agent';
  const reach = grantedChannels(g);
  if (reach.length === 0) return 'No one';
  const who = whoPhrase(g) === 'you only' ? 'You only' : 'You and approved contacts';
  const where = reach.length === 1 ? CHANNEL_LABEL[reach[0]] : plural(reach.length, 'channel');
  return `${who}, on ${where}`;
}

/** Row 4 — what it knows. */
export function knowsSummary(g: AccessGrants, knowsYou: boolean): string {
  const t = techniqueGrantOf(g);
  const head = t === '*' ? 'All techniques' : t.length === 0 ? 'No techniques' : plural(t.length, 'technique');
  return knowsYou ? `${head}, knows who you are` : head;
}
