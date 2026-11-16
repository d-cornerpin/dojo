// ════════════════════════════════════════════════════════════════════════════════
// THE DOORS READ THE GRANTS (UX-ACCESS A1) — RED-first, at the doors themselves.
//
// The sibling file holds the MODEL. This one holds the thing the census says is
// the single most consequential fact in the platform (§0):
//
//   > every outbound human channel … is gated on `isPrimaryAgent(agentId)`,
//   > which is literally `agentId === config.primary_agent_id`. Exactly one
//   > agent on the box can reach a human. There is no second tier, no grant,
//   > and no row to write.
//
// RED AT `b382580`, measured: `gatesForCall('imessage_send', {})` returns
// `{kind:'primary_only', row:'7'}`; `gatesForCall('credential_delete', …)`
// returns NOTHING (the declared `secrets` effect was refused by nothing, census C3); and the four Twilio walls plus the two
// Workspace-write walls each read `isPrimaryAgent(agentId)` in their own body.
//
// GREEN means: the SAME refusals still bite for the SAME agents (post-migration
// only the primary holds channel grants, so nothing moved), AND a non-primary
// agent that HOLDS a grant is now served, AND a credential the agent was not
// granted is refused with an audit row.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-a1-doors', 'dojo.db'),
  };
});

vi.mock('../../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config/platform.js')>('../../../config/platform.js');
  return {
    ...actual,
    isPrimaryAgent: (id: string) => id === 'primary',
    isPMAgent: (id: string) => id === 'pm',
    isHealerAgent: () => false,
    isTrainerAgent: () => false,
    getPrimaryAgentId: () => 'primary',
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { gatesForCall } from '../../tools/gates.js';
import { evaluateGate } from '../../tools/gate-eval.js';
import { forgetAccessGrants } from '../read.js';
import { deriveLegacyGrants } from '../derive.js';
import { engineMayRouteTo, engineRouteRefusalReason } from '../engine-route.js';
import type { AccessGrants } from '@dojo/shared';

const db = (): Database.Database => mockDb.current!;

function agent(id: string, classification: string, mutate?: (g: AccessGrants) => void): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, classification, session_started_at)
     VALUES (?, ?, 'idle', ?, '1970-01-01')`,
  ).run(id, id, classification);
  forgetAccessGrants();
  if (!mutate) return;
  const g = deriveLegacyGrants(id);
  mutate(g);
  db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: g }), id);
  forgetAccessGrants();
}

const ctx = (agentId: string, name: string, args: Record<string, unknown> = {}) => ({
  agentId, name, args, resolveRef: () => null,
});

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  forgetAccessGrants();
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 · THE iMESSAGE DOOR — a declared gate that reads a grant
// ════════════════════════════════════════════════════════════════════════════════

describe('gate row 7 is a CHANNEL gate', () => {
  it('⚠ ROW 7 NAMES THE CHANNEL, NOT THE ROLE SINGLETON', () => {
    for (const name of ['imessage_send', 'imessage_list_contacts']) {
      const g = gatesForCall(name, {}).find((x) => x.row === '7');
      expect(g, `${name} still carries row 7`).toBeDefined();
      expect(g!.kind).toBe('channel');
      expect(g!.kind === 'channel' && g!.channel).toBe('imessage');
    }
  });

  it('⚠ A GRANTED NON-PRIMARY AGENT IS SERVED — the inexpressible case', async () => {
    agent('operator', 'ronin', (g) => { g.channels.master = true; g.channels.imessage = 'owner'; });
    const gate = gatesForCall('imessage_send', {}).find((x) => x.row === '7')!;
    const out = await evaluateGate(gate, ctx('operator', 'imessage_send'));
    expect(out.verdict.allowed).toBe(true);
  });

  it('THE CONTROL: an agent without the grant is refused, cleanly', async () => {
    agent('worker', 'apprentice');
    const gate = gatesForCall('imessage_send', {}).find((x) => x.row === '7')!;
    const out = await evaluateGate(gate, ctx('worker', 'imessage_send'));
    expect(out.verdict.allowed).toBe(false);
    expect(out.errorCode).toBe('PERMISSION_DENIED');
    expect(out.verdict.allowed === false && out.verdict.blockedMessage).toMatch(/imessage_send/);
  });

  it('THE CONTROL: the master switch alone grants nothing', async () => {
    agent('half', 'apprentice', (g) => { g.channels.master = true; });
    const gate = gatesForCall('imessage_send', {}).find((x) => x.row === '7')!;
    expect((await evaluateGate(gate, ctx('half', 'imessage_send'))).verdict.allowed).toBe(false);
  });

  it('THE CONTROL: a per-channel grant under a `null` master grants nothing', async () => {
    agent('sensei-other', 'sensei', (g) => { g.channels.imessage = 'all'; });
    const gate = gatesForCall('imessage_send', {}).find((x) => x.row === '7')!;
    expect((await evaluateGate(gate, ctx('sensei-other', 'imessage_send'))).verdict.allowed).toBe(false);
  });

  it('the primary still passes, because it HOLDS the grant', async () => {
    agent('primary', 'sensei');
    const gate = gatesForCall('imessage_send', {}).find((x) => x.row === '7')!;
    expect((await evaluateGate(gate, ctx('primary', 'imessage_send'))).verdict.allowed).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · THE CREDENTIAL DOOR — a gate where there was none
// ════════════════════════════════════════════════════════════════════════════════

describe('the credential tools are gated', () => {
  it('⚠ A CREDENTIAL CALL NOW DECLARES A GATE', () => {
    const gates = gatesForCall('credential_delete', { service_name: 'stripe_live' });
    const g = gates.find((x) => x.kind === 'credential');
    expect(g, 'credential_delete carries a credential gate').toBeDefined();
    expect(g!.kind === 'credential' && g!.service).toBe('stripe_live');
  });

  it('⚠ THE HOLE IS SHUT: an ungranted agent is refused and AUDITED', async () => {
    // A1 scoped the refusal per SERVICE NAME; the owner's A5 order made the grant
    // one switch and deleted the per-name reader, so the fixture is an agent that
    // holds no credential access rather than one that holds a different name. The
    // hole this clause was written for — census C3, any agent deletes any
    // credential — is the same hole and is still shut, and the AUDIT still names
    // the credential that was reached for.
    agent('reader', 'ronin', (g) => { g.integrations.credentials = false; });
    const gate = gatesForCall('credential_delete', { service_name: 'stripe_live' })
      .find((x) => x.kind === 'credential')!;
    const out = await evaluateGate(gate, ctx('reader', 'credential_delete', { service_name: 'stripe_live' }));
    expect(out.verdict.allowed).toBe(false);
    expect(out.errorCode).toBe('PERMISSION_DENIED');
    expect(out.resource).toBe('stripe_live');
  });

  it('THE POSITIVE CONTROL: a granted agent still opens it', async () => {
    agent('reader', 'ronin', (g) => { g.integrations.credentials = true; });
    const gate = gatesForCall('credential_get', { service_name: 'plaud_token' })
      .find((x) => x.kind === 'credential')!;
    expect((await evaluateGate(gate, ctx('reader', 'credential_get', { service_name: 'plaud_token' }))).verdict.allowed).toBe(true);
  });

  it('THE MIGRATION CONTROL: an agent carrying the migrated grant is refused nothing', async () => {
    agent('worker', 'apprentice');
    const gate = gatesForCall('credential_delete', { service_name: 'stripe_live' })
      .find((x) => x.kind === 'credential')!;
    expect((await evaluateGate(gate, ctx('worker', 'credential_delete', { service_name: 'stripe_live' }))).verdict.allowed).toBe(true);
  });

  it('`credential_list` names no service, so it gates on holding ANY grant', async () => {
    agent('none', 'apprentice', (g) => { g.integrations.credentials = false; });
    const gate = gatesForCall('credential_list', {}).find((x) => x.kind === 'credential')!;
    expect((await evaluateGate(gate, ctx('none', 'credential_list'))).verdict.allowed).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 · THE HANDLER WALLS — the predicate moved; the wall did not
// ════════════════════════════════════════════════════════════════════════════════

describe('the four Twilio walls and the two Workspace walls read the grant', () => {

  it('and the reply sender (which carries the relay) refuses / serves by the grant, driven', () => {
    agent('primary', 'sensei');
    agent('operator', 'ronin', (g) => { g.channels.master = true; g.channels.email = 'owner'; });
    agent('worker', 'apprentice');
    expect(engineMayRouteTo('primary', 'email')).toBe(true);
    expect(engineMayRouteTo('operator', 'email')).toBe(true);
    expect(engineMayRouteTo('worker', 'email')).toBe(false);
    expect(engineRouteRefusalReason('email')).toMatch(/channel/i);
  });
});

describe('the enforcement surface moved in one direction only', () => {
  it('the declared `secrets` effect meets the credential gate', async () => {
    expect(gatesForCall('credential_get', { service_name: 'x' }).some((g) => g.kind === 'credential')).toBe(true);
  });

  it('a tool that reaches nobody gains no channel gate', () => {
    for (const name of ['send_to_agent', 'show_to_user', 'file_read', 'web_search']) {
      expect(gatesForCall(name, { path: '/tmp/x', url: 'https://x.test' }).some((g) => g.kind === 'channel'), name).toBe(false);
    }
  });
});
