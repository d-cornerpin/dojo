// Profiles FILL THE PANEL; the owner's save goes through the same validated door as any edit.
// They live here because the group list is a server module; a dashboard copy would drift.

import type { AccessChannel, AccessGrants } from '@dojo/shared';
import { ACCESS_CHANNELS, MOST_RESTRICTIVE_GRANTS, channelOfSendTool, cloneGrants } from '@dojo/shared';
import { SEND_TO_PEOPLE } from '../sensei-policy.js';
import { TOOL_CATEGORIES } from '../../tools/categories.js';

export interface AccessPreset {
  readonly id: 'most_restrictive' | 'reader' | 'operator' | 'full_trust';
  readonly label: string;
  /** One line, owner-facing. A preset is a GRANTS object: it cannot grant manifest switches, so
   *  this sentence may only claim what `grants` actually applies. */
  readonly description: string;
  readonly grants: AccessGrants;
}

// ── The channel ⇄ tool-group coupling, derived ──

/** The groups whose tools reach a human on `channel`, DERIVED from the build-checked send surface
 *  and the canonical tool→channel map: a tool re-filed into another label moves this answer. */
function buildChannelGroups(): Record<AccessChannel, string[]> {
  const out = Object.fromEntries(ACCESS_CHANNELS.map((c) => [c, [] as string[]])) as Record<AccessChannel, string[]>;
  for (const category of TOOL_CATEGORIES) {
    for (const tool of category.tools) {
      if (!SEND_TO_PEOPLE.includes(tool)) continue;
      // `channelOfSendTool` answers `phone` for the phone channel; the grants object calls it `voice`.
      const kind = channelOfSendTool(tool);
      const channel = (kind === 'phone' ? 'voice' : kind) as AccessChannel | null;
      if (!channel || !ACCESS_CHANNELS.includes(channel)) continue;
      if (!out[channel].includes(category.label)) out[channel].push(category.label);
    }
  }
  // `imessage_list_contacts` is not a SEND, but its group already contains the send tool.
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

/** The groups a sub-agent needs to exist at all: the most-restrictive floor's list, named once. */
const FLOOR = MOST_RESTRICTIVE_GRANTS.tools.categories as string[];

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

/** The four, in the order an owner meets them: safe default first, wide-open last. */
export const ACCESS_PRESETS: readonly AccessPreset[] = [
  preset(
    'most_restrictive',
    'Most restrictive',
    'Its own files and its own task list. No people, no accounts, no keys. Every new agent starts here.',
    () => { /* the constant itself, the default, unmodified */ },
  ),
  preset(
    'reader',
    'Reader',
    'Looks at things, touches nothing, stays quiet — your recordings, mail and calendar, read only.',
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
    'Can text you on iMessage — you and nobody else on the contact list.',
    (g) => {
      g.tools.categories = [...FLOOR, COMMUNICATION];
      g.channels.master = true;
      g.channels.imessage = 'owner';
    },
  ),
  preset(
    'full_trust',
    'Full trust (like your main agent)',
    'Everything your main agent holds: every tool, every account, your keys, every channel, everyone.',
    (g) => {
      g.tools.categories = '*';
      g.integrations.plaud = true;
      g.integrations.credentials = true;
      g.integrations.google = { agent: 'full', user: 'full' };
      g.integrations.microsoft = { agent: 'full', user: 'full' };
      g.channels.master = true;
      for (const channel of ACCESS_CHANNELS) g.channels[channel] = 'all';
      // The only preset naming `'*'`: a technique is a standing procedure the matcher can inject
      // unasked, so the narrower profiles leave the section empty for the owner to tick.
      g.techniques = '*';
    },
  ),
];
