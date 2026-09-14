// ════════════════════════════════════════════════════════════════════════════
// THE PRESETS (UX-ACCESS A3) — four profiles, one click, then the owner adjusts.
//
// The plan names them: *"presets incl. the owner's two exemplar profiles
// ('Reader: Plaud + chosen mail accounts, no channels' · 'Operator: exec +
// iMessage-me')"*, beside ruling 2's most-restrictive default and a
// primary-like full-trust profile. A preset FILLS THE CHECKBOXES; it never
// saves. The owner adjusts and presses save, which goes through the same
// validated door (`resolveUpdateGrants`) and writes the same audit row as any
// other edit — a preset is a starting point, not a second write path.
//
// ── WHY THEY LIVE ON THE SERVER ──
// A preset names TOOL GROUPS, and the list of groups is `TOOL_CATEGORIES`, a
// server module. A copy in the dashboard would be a second truth that drifts the
// first time somebody re-files a tool — which is precisely the disease this
// overhaul exists to end. The panel fetches them (`GET /api/access/catalog`)
// along with the group list it draws checkboxes from.
//
// ── THE HONESTY RULE, AND WHY IT IS TESTED RATHER THAN REMEMBERED ──
// A2 §6.2 handed A3 a finding: *"a channel granted without its tool category is
// inert"*. With A3's rider the inert case became a REFUSAL at the executor, so a
// preset that grants a channel without the group its send tool lives in would
// hand the owner a profile that cannot do the thing its own name promises.
// `channelToolGroups` answers which groups a channel needs — DERIVED from the
// index, so re-filing `imessage_send` moves the answer with it — and the preset
// test walks every preset against it.
// ════════════════════════════════════════════════════════════════════════════

import type { AccessChannel, AccessGrants } from '@dojo/shared';
import { ACCESS_CHANNELS, MOST_RESTRICTIVE_GRANTS, channelOfSendTool, cloneGrants } from '@dojo/shared';
import { SEND_TO_PEOPLE } from '../sensei-policy.js';
import { TOOL_CATEGORIES } from '../../tools/categories.js';

export interface AccessPreset {
  readonly id: 'most_restrictive' | 'reader' | 'operator' | 'full_trust';
  readonly label: string;
  /** One line, owner-facing: what this profile lets the agent do. */
  readonly description: string;
  readonly grants: AccessGrants;
}

// ── The channel ⇄ tool-group coupling, derived ──

/** The groups whose tools actually reach a human on `channel`.
 *
 *  Built from two things that already exist and are already build-checked:
 *  `SEND_TO_PEOPLE` (the comms-to-people surface, held exhaustive by
 *  `sensei-policy`'s own census) and `channelOfSendTool` (the canonical
 *  send-tool → channel map in `@dojo/shared`). Nothing here is hand-listed, so a
 *  tool re-filed into another label moves this answer with it. */
function buildChannelGroups(): Record<AccessChannel, string[]> {
  const out = Object.fromEntries(ACCESS_CHANNELS.map((c) => [c, [] as string[]])) as Record<AccessChannel, string[]>;
  for (const category of TOOL_CATEGORIES) {
    for (const tool of category.tools) {
      if (!SEND_TO_PEOPLE.includes(tool)) continue;
      // `channelOfSendTool` answers in `ChannelKind`, where the phone channel is
      // called `phone`; the grants object calls it `voice`. One rename, stated
      // here rather than by keeping a second list.
      const kind = channelOfSendTool(tool);
      const channel = (kind === 'phone' ? 'voice' : kind) as AccessChannel | null;
      if (!channel || !ACCESS_CHANNELS.includes(channel)) continue;
      if (!out[channel].includes(category.label)) out[channel].push(category.label);
    }
  }
  // `imessage_list_contacts` is not a SEND, but iMessage's send tool is in the
  // same group, so the derivation above already covers the channel.
  return out;
}

const CHANNEL_GROUPS = buildChannelGroups();

/** Which tool groups a channel grant needs to be anything but inert. */
export function channelToolGroups(channel: AccessChannel): string[] {
  return [...(CHANNEL_GROUPS[channel] ?? [])];
}

/** The whole map, for the panel's inline warning. */
export function channelToolGroupMap(): Record<AccessChannel, string[]> {
  return Object.fromEntries(
    ACCESS_CHANNELS.map((c) => [c, channelToolGroups(c)]),
  ) as Record<AccessChannel, string[]>;
}

// ── The four profiles ──

/** Every group a sub-agent needs to exist at all: its own lifecycle, its files,
 *  and the two-phase tool loader. Ruling 2's floor, named once. */
const FLOOR = MOST_RESTRICTIVE_GRANTS.tools.categories as string[];

/** The read-side Workspace groups. Mail and calendar on both providers, plus the
 *  cross-account search that spans them — the "chosen mail accounts" half of the
 *  owner's Reader profile. WHICH accounts is then a per-account checkbox in the
 *  panel; the preset opens the door and the owner narrows it. */
const MAIL_AND_CALENDAR = [
  'Unified Search (all connected accounts at once)',
  'Gmail',
  'Google Calendar',
  'Outlook',
  'Microsoft Calendar',
];

const PLAUD = 'Plaud (voice recorder integration)';
const COMMUNICATION = 'Communication';

function preset(
  id: AccessPreset['id'],
  label: string,
  description: string,
  build: (g: AccessGrants) => void,
): AccessPreset {
  const grants = cloneGrants(MOST_RESTRICTIVE_GRANTS);
  build(grants);
  return { id, label, description, grants };
}

/**
 * THE FOUR, in the order an owner meets them: the safe default first, the two
 * exemplar profiles next, the wide-open one last.
 */
export const ACCESS_PRESETS: readonly AccessPreset[] = [
  preset(
    'most_restrictive',
    'Most restrictive',
    'Files and scratchpad only. No channels, no integrations, no credentials. This is what every new agent starts as.',
    () => { /* the constant itself — ruling 2's default, unmodified */ },
  ),
  preset(
    'reader',
    'Reader',
    'Reads Plaud recordings, mail and calendar. Cannot send anything and cannot reach a person.',
    (g) => {
      g.tools.categories = [...FLOOR, PLAUD, ...MAIL_AND_CALENDAR, 'Conversation Recall', 'Vault (Long-Term Memory)'];
      g.integrations.plaud = true;
      g.integrations.google = { agent: 'read', user: 'read' };
      g.integrations.microsoft = { agent: 'read', user: 'read' };
    },
  ),
  preset(
    'operator',
    'Operator',
    'Runs commands on this Mac and can iMessage you — only you, nobody else on the contact list.',
    (g) => {
      g.tools.categories = [...FLOOR, COMMUNICATION];
      g.channels.master = true;
      g.channels.imessage = 'owner';
    },
  ),
  preset(
    'full_trust',
    'Full trust (primary-like)',
    'Everything the main agent holds: every tool group, every integration, every credential, every channel, everyone.',
    (g) => {
      g.tools.categories = '*';
      g.integrations.plaud = true;
      g.integrations.credentials = true;
      g.integrations.google = { agent: 'full', user: 'full' };
      g.integrations.microsoft = { agent: 'full', user: 'full' };
      g.channels.master = true;
      for (const channel of ACCESS_CHANNELS) g.channels[channel] = 'all';
      // UX-ACCESS A4: the only preset that names `'*'`. The other three leave
      // `techniques: []` (the constant's own value), because a technique is a
      // standing procedure the matcher can inject unasked and none of the three
      // narrower profiles is about running the owner's procedures. The owner
      // ticks the ones he wants — which is the point of the section being a
      // grant rather than a default.
      g.techniques = '*';
    },
  ),
];
