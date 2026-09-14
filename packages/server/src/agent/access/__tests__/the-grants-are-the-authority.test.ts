// ════════════════════════════════════════════════════════════════════════════
// THE GRANTS ARE THE AUTHORITY (UX-ACCESS A1) — RED-first.
//
// Four claims, and every one of them is FALSE at `b382580`:
//
//   1. THE ÜBER TOGGLE EXISTS. A per-channel grant is inert unless the master
//      switch is on, and a sensei other than the primary has no master at all
//      (owner ruling 1). At HEAD there is no master, no per-channel grant and no
//      row to write — `isPrimaryAgent` is the whole of it (census §0, C1).
//   2. THE SNAPSHOT IS EXACT. Every agent's grants, derived, reproduce its
//      effective access at HEAD — primary everything, sensei its current set,
//      everyone else theirs (owner ruling 3).
//   3. THE WALLS TAKE AGENT IDENTITY. A non-primary agent that HOLDS a channel
//      grant is served; one that does not is refused cleanly, with an audit row.
//      At HEAD the first half is impossible: the only way to grant iMessage is
//      to make the agent `config.primary_agent_id` (census §9, case 2).
//   4. CREDENTIALS AND PERSONAL MAIL ARE SCOPED. A credential the agent was not
//      granted is refused at the door (at HEAD every agent may delete
//      `stripe_live`, census C3); a personal-mailbox read the agent was not
//      granted is refused while its own mailbox still works (at HEAD the two
//      cannot be separated, census C4).
//
// Every refusal clause carries its positive control, because a validator that
// refuses everything passes a file full of negatives.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

vi.mock('../../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config/platform.js')>('../../../config/platform.js');
  return {
    ...actual,
    isPrimaryAgent: (id: string) => id === 'primary',
    isPMAgent: (id: string) => id === 'pm',
    isHealerAgent: () => false,
    isTrainerAgent: () => false,
    getPrimaryAgentId: () => 'primary',
    getSmsReachability: undefined,
  };
});

import {
  MOST_RESTRICTIVE_GRANTS, channelTierOf, mayReachChannel, mayReachOthersOn,
  providerLevelOf, mayTouchCredentialIn, stableGrantsText, type AccessGrants,
} from '@dojo/shared';
import { deriveLegacyGrants } from '../derive.js';
import {
  getAccessGrants, forgetAccessGrants, mayUseChannel, channelTierFor, hasChannelMaster,
  integrationLevelFor, mayTouchCredential, holdsCredentialGrant, toolCategoryGranted,
} from '../read.js';
import { materializeAccessGrants, writeGrantsIfAbsent } from '../materialize.js';
import { channelForTool, CHANNEL_TOOLS } from '../channels.js';
import { SEND_TO_PEOPLE } from '../../sensei-policy.js';

// ── A database with exactly the columns these readers touch ──
function seed(rows: Array<{ id: string; classification?: string; permissions?: string; toolsPolicy?: string }>): void {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, classification TEXT,
      permissions TEXT, tools_policy TEXT, updated_at TEXT
    );
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
  `);
  const ins = db.prepare(
    'INSERT INTO agents (id, name, classification, permissions, tools_policy) VALUES (?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    ins.run(r.id, r.id, r.classification ?? 'apprentice', r.permissions ?? '{}', r.toolsPolicy ?? '{}');
  }
  mockDb.current = db;
  forgetAccessGrants();
}

const permissionsOf = (id: string): string =>
  (mockDb.current!.prepare('SELECT permissions FROM agents WHERE id = ?').get(id) as { permissions: string }).permissions;

/** A grants object with one field overridden — the fixture for the walls below. */
function grantsWith(base: AccessGrants, mutate: (g: AccessGrants) => void): string {
  const g = JSON.parse(JSON.stringify(base)) as AccessGrants;
  mutate(g);
  return JSON.stringify({ grants: g });
}

beforeEach(() => { mockDb.current = null; forgetAccessGrants(); });

// ════════════════════════════════════════════════════════════════════════════
// 1 · THE ÜBER TOGGLE — the master, and what sits beneath it
// ════════════════════════════════════════════════════════════════════════════

describe('owner ruling 1 — the master switch, and per-channel grants beneath it', () => {
  const withChannels = (master: boolean | null, imessage: 'none' | 'owner' | 'all'): AccessGrants => ({
    ...MOST_RESTRICTIVE_GRANTS,
    channels: { master, imessage, sms: 'none', voice: 'none', email: 'none', teams: 'none' },
  });

  it('⚠ A GRANTED CHANNEL IS INERT WITHOUT THE MASTER', () => {
    // The ruling's own words: granular per-channel grants "sit beneath it and
    // are inert unless the master is on". Read through the ONE reader, so a call
    // site cannot re-implement the rule and get it wrong.
    expect(channelTierOf(withChannels(false, 'all'), 'imessage')).toBe('none');
    expect(mayReachChannel(withChannels(false, 'all'), 'imessage')).toBe(false);
  });

  it('a sensei that is not the primary has NO master, and that is not "on"', () => {
    expect(channelTierOf(withChannels(null, 'all'), 'imessage')).toBe('none');
  });

  it('THE POSITIVE CONTROL: master on + channel granted = reachable', () => {
    expect(channelTierOf(withChannels(true, 'all'), 'imessage')).toBe('all');
    expect(mayReachChannel(withChannels(true, 'all'), 'imessage')).toBe(true);
  });

  it('the me-vs-others tier is real: `owner` reaches the owner and nobody else', () => {
    const g = withChannels(true, 'owner');
    expect(mayReachChannel(g, 'imessage')).toBe(true);
    expect(mayReachOthersOn(g, 'imessage')).toBe(false);
    expect(mayReachOthersOn(withChannels(true, 'all'), 'imessage')).toBe(true);
  });

  it('owner ruling 2 is EXPRESSIBLE: the most-restrictive shape holds nothing but files', () => {
    expect(MOST_RESTRICTIVE_GRANTS.channels.master).toBe(false);
    expect(MOST_RESTRICTIVE_GRANTS.integrations.credentials).toEqual([]);
    expect(MOST_RESTRICTIVE_GRANTS.integrations.plaud).toBe(false);
    expect(providerLevelOf(MOST_RESTRICTIVE_GRANTS.integrations.google, 'user')).toBe('none');
    expect(mayTouchCredentialIn(MOST_RESTRICTIVE_GRANTS, 'stripe_live')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2 · THE SNAPSHOT — owner ruling 3, per agent class
// ════════════════════════════════════════════════════════════════════════════

describe('owner ruling 3 — the snapshot reproduces today’s effective access', () => {
  beforeEach(() => {
    seed([
      { id: 'primary', classification: 'sensei' },
      { id: 'pm', classification: 'sensei' },
      { id: 'ticky', classification: 'sensei', toolsPolicy: JSON.stringify({ allow: [], deny: ['gmail_send'] }) },
      { id: 'worker', classification: 'apprentice' },
    ]);
  });

  it('the primary keeps EVERYTHING — every channel, at the widest tier', () => {
    const g = deriveLegacyGrants('primary');
    expect(g.channels.master).toBe(true);
    for (const ch of ['imessage', 'sms', 'voice', 'email', 'teams'] as const) {
      expect(channelTierOf(g, ch), ch).toBe('all');
    }
    expect(g.integrations.google.agent).toBe('full');
    expect(g.integrations.google.user).toBe('full');
    expect(g.integrations.microsoft.user).toBe('full');
  });

  it('a sensei that is not the primary keeps its set — and carries NO master', () => {
    const g = deriveLegacyGrants('ticky');
    expect(g.channels.master).toBeNull();
    expect(mayReachChannel(g, 'imessage')).toBe(false);
    // Its curated policy moved into the object verbatim, both directions.
    expect(g.tools.deny).toEqual(['gmail_send']);
    // Read tier for Workspace — the ladder at `google/auth.ts:761`, transcribed.
    expect(g.integrations.google.agent).toBe('read');
  });

  it('the PM keeps `none` for both Workspace providers', () => {
    const g = deriveLegacyGrants('pm');
    expect(g.integrations.google.agent).toBe('none');
    expect(g.integrations.microsoft.agent).toBe('none');
  });

  it('every non-sensei agent gets a master switch, and it is OFF', () => {
    const g = deriveLegacyGrants('worker');
    expect(g.channels.master).toBe(false);
    expect(hasChannelMaster('worker')).toBe(true);
    expect(hasChannelMaster('ticky')).toBe(false);
  });

  it('Plaud and the credential vault are snapshot as they are today: everyone', () => {
    // Census C13 and C3 — the two integrations with no identity check at all.
    expect(deriveLegacyGrants('worker').integrations.plaud).toBe(true);
    expect(deriveLegacyGrants('worker').integrations.credentials).toBe('*');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3 · MATERIALIZATION — the declared object, and the proof it changed nothing
// ════════════════════════════════════════════════════════════════════════════

describe('the migration writes what the derivation already answered', () => {
  beforeEach(() => {
    seed([
      { id: 'primary', classification: 'sensei' },
      { id: 'worker', classification: 'apprentice', permissions: JSON.stringify({ file_read: ['/tmp/**'], exec_allow: ['ls'] }) },
    ]);
  });

  it('⚠ THE DIFF IS EMPTY, PER AGENT, ACROSS THE WRITE', () => {
    const before = new Map<string, string>();
    for (const id of ['primary', 'worker']) before.set(id, stableGrantsText(getAccessGrants(id)));
    expect(materializeAccessGrants()).toBe(2);
    for (const id of ['primary', 'worker']) {
      expect(stableGrantsText(getAccessGrants(id)), id).toBe(before.get(id));
    }
  });

  it('the manifest fields already in the blob survive the write untouched', () => {
    materializeAccessGrants();
    const doc = JSON.parse(permissionsOf('worker')) as Record<string, unknown>;
    expect(doc.file_read).toEqual(['/tmp/**']);
    expect(doc.exec_allow).toEqual(['ls']);
    expect(doc.grants).toBeTruthy();
  });

  it('it is NOT a boot rewriter: a second pass writes nothing and never overwrites', () => {
    materializeAccessGrants();
    // The owner edits the stored object — the thing the four boot reconcilers
    // used to revert on every restart (census C8).
    const edited = grantsWith(deriveLegacyGrants('worker'), (g) => { g.channels.master = true; g.channels.imessage = 'owner'; });
    mockDb.current!.prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(edited, 'worker');
    forgetAccessGrants();
    expect(materializeAccessGrants()).toBe(0);
    expect(writeGrantsIfAbsent('worker')).toBeNull();
    expect(channelTierFor('worker', 'imessage')).toBe('owner');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4 · THE WALLS — driven, both directions
// ════════════════════════════════════════════════════════════════════════════

describe('the channel doors take agent identity, not a role singleton', () => {
  beforeEach(() => {
    seed([
      { id: 'primary', classification: 'sensei' },
      { id: 'operator', classification: 'ronin' },
      { id: 'reader', classification: 'ronin' },
    ]);
    // The owner's own exemplar profiles, as grants.
    const operator = grantsWith(deriveLegacyGrants('operator'), (g) => {
      g.channels.master = true;
      g.channels.imessage = 'owner';
    });
    const reader = grantsWith(deriveLegacyGrants('reader'), (g) => {
      g.integrations.google.user = 'none';
      g.integrations.microsoft.user = 'none';
      g.integrations.credentials = ['plaud_token'];
    });
    mockDb.current!.prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(operator, 'operator');
    mockDb.current!.prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(reader, 'reader');
    forgetAccessGrants();
  });

  it('⚠ A NON-PRIMARY AGENT CAN HOLD iMESSAGE — the case that was inexpressible', () => {
    expect(mayUseChannel('operator', 'imessage')).toBe(true);
    expect(channelTierFor('operator', 'imessage')).toBe('owner');
  });

  it('…and one that was not granted it is still refused', () => {
    expect(mayUseChannel('reader', 'imessage')).toBe(false);
    expect(mayUseChannel('reader', 'email')).toBe(false);
  });

  it('the primary is not special-cased anywhere: it holds the grant like anyone else', () => {
    expect(mayUseChannel('primary', 'imessage')).toBe(true);
  });

  it('granting one channel grants no other', () => {
    expect(mayUseChannel('operator', 'sms')).toBe(false);
    expect(mayUseChannel('operator', 'voice')).toBe(false);
    expect(mayUseChannel('operator', 'teams')).toBe(false);
  });
});

describe('credentials are scoped to the grant', () => {
  beforeEach(() => {
    seed([{ id: 'reader', classification: 'ronin' }, { id: 'worker', classification: 'apprentice' }]);
    const reader = grantsWith(deriveLegacyGrants('reader'), (g) => { g.integrations.credentials = ['plaud_token']; });
    const none = grantsWith(deriveLegacyGrants('worker'), (g) => { g.integrations.credentials = []; });
    mockDb.current!.prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(reader, 'reader');
    mockDb.current!.prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(none, 'worker');
    forgetAccessGrants();
  });

  it('⚠ THE any-AGENT-DELETES-ANY-CREDENTIAL HOLE IS SHUT', () => {
    expect(mayTouchCredential('reader', 'stripe_live')).toBe(false);
  });

  it('THE POSITIVE CONTROL: the one it WAS granted still opens', () => {
    expect(mayTouchCredential('reader', 'plaud_token')).toBe(true);
    expect(holdsCredentialGrant('reader')).toBe(true);
  });

  it('an empty grant holds nothing at all, and the vault stops being reachable', () => {
    expect(holdsCredentialGrant('worker')).toBe(false);
    expect(mayTouchCredential('worker', 'plaud_token')).toBe(false);
  });
});

describe('personal mail is separable from the agent’s own', () => {
  beforeEach(() => {
    seed([{ id: 'reader', classification: 'ronin' }]);
    const reader = grantsWith(deriveLegacyGrants('reader'), (g) => { g.integrations.google.user = 'none'; });
    mockDb.current!.prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(reader, 'reader');
    forgetAccessGrants();
  });

  it('⚠ WORK MAIL YES, PERSONAL MAIL NO — the split the schema had no word for', () => {
    expect(integrationLevelFor('reader', 'google', 'agent')).toBe('read');
    expect(integrationLevelFor('reader', 'google', 'user')).toBe('none');
  });

  it('a per-ACCOUNT override outranks its kind', () => {
    const g = deriveLegacyGrants('reader');
    g.integrations.google.accounts = { 'work-2': 'full' };
    expect(providerLevelOf(g.integrations.google, 'agent', 'work-2')).toBe('full');
    expect(providerLevelOf(g.integrations.google, 'agent', 'other')).toBe('read');
  });
});

describe('the tool layer', () => {
  beforeEach(() => {
    seed([{ id: 'narrow', classification: 'ronin' }, { id: 'wide', classification: 'ronin' }]);
    const narrow = grantsWith(deriveLegacyGrants('narrow'), (g) => { g.tools.categories = ['Web']; });
    mockDb.current!.prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(narrow, 'narrow');
    forgetAccessGrants();
  });

  it('a category the agent does not hold is not granted', () => {
    expect(toolCategoryGranted('narrow', 'exec')).toBe(false);
    expect(toolCategoryGranted('narrow', 'web_search')).toBe(true);
  });

  it('a migrated agent holds every category, so the layer refuses nothing today', () => {
    expect(toolCategoryGranted('wide', 'exec')).toBe(true);
    expect(toolCategoryGranted('wide', 'imessage_send')).toBe(true);
  });

  it('a tool in no category is never refused by the category layer', () => {
    // `user_` twins, Office, anything registered outside the 38 declared groups.
    expect(toolCategoryGranted('narrow', 'user_gmail_inbox')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5 · THE CENSUS — every owner-channel tool maps to exactly one channel
// ════════════════════════════════════════════════════════════════════════════

describe('the channel map is exhaustive over the build-checked send surface', () => {
  it('every SEND_TO_PEOPLE name resolves to a channel', () => {
    const unmapped = SEND_TO_PEOPLE.filter((n) => channelForTool(n) === null);
    expect(unmapped, `unmapped owner-channel tools: ${unmapped.join(', ')}`).toEqual([]);
  });

  it('and the map names nothing that is not on that surface', () => {
    const extra = Object.keys(CHANNEL_TOOLS).filter((n) => !SEND_TO_PEOPLE.includes(n));
    expect(extra, `channel map names non-send tools: ${extra.join(', ')}`).toEqual([]);
  });

  it('a tool that reaches nobody maps to no channel', () => {
    expect(channelForTool('file_read')).toBeNull();
    expect(channelForTool('send_to_agent')).toBeNull();
  });
});
