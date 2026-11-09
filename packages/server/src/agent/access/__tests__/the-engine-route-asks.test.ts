// ════════════════════════════════════════════════════════════════════════════════
// THE ENGINE'S AUTO-ROUTE ASKS THE GRANT (UX-ACCESS A4, scope item 3) — RED-first.
//
// A1 §6.2, A2 §6.4 and A3 §7.2 recorded the same hand-up three times, verbatim:
// *"The engine auto-route paths (`channel-push.ts`, `turn-closures.ts`) still
// cross no wall, exactly as at HEAD."* The plan's DESIGN promises the opposite —
// *"channel doors take agent identity (killing the `isPrimaryAgent` hardcode)"* —
// and A4 is where that is spent.
//
// ── THE PREMISE THE BRIEF OFFERED IS FALSE, AND THE CORRECTION IS THE POINT ──
// The task brief argued this was migration-safe because *"primary holds all
// channels post-migration"*. MEASURED on the owner's live `deliveries` ledger at
// `ac945a99`:
//
//     57b52025-… (HarnessBot, ronin)  auto-route imessage 152
//     57b52025-…                       auto-route email      7
//     57b52025-…                       engine-ack imessage    3
//     FXID.n4      (the primary)         auto-route  —          0
//
// Every engine-routed human delivery this box has ever made was sent by an agent
// holding NO channel grant, and the primary has made none. So this is a REAL
// narrowing with a named victim. It is not smuggled through as an empty diff;
// §4 is the honest statement of what it costs and what it does not.
//
// FOUR PREDICATE PROPERTIES, and each is a bug that would otherwise be silent:
//   · `'phone'` (the routing/ledger union) must map to `'voice'` (the grant
//     union) or the guard never fires for a live call;
//   · `'dashboard'` must answer "no opinion" or a narrowed agent goes MUTE,
//     which would be a far worse defect than the one being fixed;
//   · `'a2a'`/`'engine'` reach no human and must acquire no opinion either;
//   · the ÜBER TOGGLE governs, because `channelTierOf` governs the reader.
//
// RED AT `ac945a99`: `agent/access/engine-route.js` does not exist.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-a4-engine-route', 'dojo.db'),
  };
});

vi.mock('../../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config/platform.js')>('../../../config/platform.js');
  return {
    ...actual,
    isPrimaryAgent: (id: string) => id === 'primary',
    isPMAgent: (id: string) => id === 'pm',
    getPrimaryAgentId: () => 'primary',
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { channelForDestination, engineMayRouteTo, engineRouteRefusalReason } from '../engine-route.js';
import { forgetAccessGrants, mayUseChannel, mayReachOthersOn } from '../read.js';
import { deriveLegacyGrants } from '../derive.js';
import { ACCESS_CHANNELS } from '@dojo/shared';
import type { AccessGrants, Channel } from '@dojo/shared';

const db = (): Database.Database => mockDb.current!;

function agent(id: string, mutate?: (g: AccessGrants) => void): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, classification, created_by, spawn_depth, session_started_at)
     VALUES (?, ?, 'idle', 'apprentice', ?, 1, '1970-01-01')`,
  ).run(id, id, id === 'primary' ? 'system' : 'primary');
  forgetAccessGrants();
  if (!mutate) return;
  const g = deriveLegacyGrants(id);
  mutate(g);
  db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: g }), id);
  forgetAccessGrants();
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  forgetAccessGrants();
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 · THE DESTINATION → CHANNEL MAP
// ════════════════════════════════════════════════════════════════════════════════

describe('channelForDestination', () => {
  it('⚠ `phone` MAPS TO `voice` — the two unions disagree on exactly this member', () => {
    // `agent/v2/deliveries.ts` and the reply resolver say `phone`; `ACCESS_CHANNELS`
    // says `voice`. A guard written by matching the string would silently never
    // fire for a live call, which is the loudest of the ungated transports.
    expect(channelForDestination('phone')).toBe('voice');
    expect(channelForDestination('voice')).toBe('voice');
  });

  it('the four that agree, agree', () => {
    expect(channelForDestination('imessage')).toBe('imessage');
    expect(channelForDestination('sms')).toBe('sms');
    expect(channelForDestination('teams')).toBe('teams');
    expect(channelForDestination('email')).toBe('email');
  });

  it('⚠ `dashboard` HAS NO OPINION — a narrowed agent must not go mute', () => {
    expect(channelForDestination('dashboard')).toBeNull();
  });

  it('`a2a` and `engine` reach no human, so they acquire no opinion either', () => {
    expect(channelForDestination('a2a')).toBeNull();
    expect(channelForDestination('engine')).toBeNull();
  });

  it('every ACCESS_CHANNEL is reachable from some destination — no grant is unenforceable', () => {
    const reached = new Set(
      (['imessage', 'sms', 'teams', 'email', 'phone', 'voice', 'dashboard', 'a2a', 'engine'] as Channel[])
        .map(channelForDestination)
        .filter((c): c is NonNullable<typeof c> => c !== null),
    );
    for (const c of ACCESS_CHANNELS) expect(reached.has(c), `${c} is reachable`).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · THE PREDICATE
// ════════════════════════════════════════════════════════════════════════════════

describe('engineMayRouteTo', () => {
  it('⚠ AN AGENT WITH NO CHANNEL GRANT IS REFUSED ON EVERY HUMAN DESTINATION', () => {
    agent('nogrant', (g) => { g.channels.master = false; });
    for (const destination of ['imessage', 'sms', 'phone', 'email', 'teams'] as Channel[]) {
      expect(engineMayRouteTo('nogrant', destination), `${destination} refused`).toBe(false);
    }
  });

  it('and is ALLOWED on the dashboard, which is where its reply already is', () => {
    agent('nogrant', (g) => { g.channels.master = false; });
    expect(engineMayRouteTo('nogrant', 'dashboard')).toBe(true);
  });

  it('the primary routes everywhere — the A1 snapshot gives it every channel', () => {
    agent('primary');
    for (const destination of ['imessage', 'sms', 'phone', 'email', 'teams', 'dashboard'] as Channel[]) {
      expect(engineMayRouteTo('primary', destination), `${destination} allowed`).toBe(true);
    }
  });

  it('one channel granted opens ONE destination', () => {
    agent('operator', (g) => { g.channels.master = true; g.channels.imessage = 'owner'; });
    expect(engineMayRouteTo('operator', 'imessage')).toBe(true);
    expect(engineMayRouteTo('operator', 'sms')).toBe(false);
    expect(engineMayRouteTo('operator', 'phone')).toBe(false);
  });

  it('⚠ THE ÜBER TOGGLE GOVERNS — a per-channel value under a false master is inert', () => {
    agent('muted', (g) => { g.channels.master = false; g.channels.imessage = 'all'; });
    expect(engineMayRouteTo('muted', 'imessage')).toBe(false);
    // And it is inert because the READER says so, not because this module
    // re-implemented ruling 1.
    expect(mayUseChannel('muted', 'imessage')).toBe(false);
  });

  it('a sensei (master `null`) is refused, and `null` is not "on"', () => {
    agent('sensei', (g) => { g.channels.master = null; });
    expect(engineMayRouteTo('sensei', 'imessage')).toBe(false);
  });

  it('the refusal reason names the channel, in the GRANT union\'s word', () => {
    expect(engineRouteRefusalReason('phone')).toContain('no voice channel grant');
    expect(engineRouteRefusalReason('imessage')).toContain('no imessage channel grant');
    // And it says where the answer actually is, because a held reply is not a
    // lost one.
    expect(engineRouteRefusalReason('sms')).toContain('dashboard chat');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 · THE ME-VS-OTHERS TIER GETS ITS FIRST READER
// ════════════════════════════════════════════════════════════════════════════════

describe('the tier is enforced, not merely declared', () => {

  it('the tier answers `owner` vs `all` through the ONE reader', () => {
    agent('owner-only', (g) => { g.channels.master = true; g.channels.imessage = 'owner'; });
    agent('anyone', (g) => { g.channels.master = true; g.channels.imessage = 'all'; });
    expect(mayUseChannel('owner-only', 'imessage')).toBe(true);
    expect(mayReachOthersOn('owner-only', 'imessage')).toBe(false);
    expect(mayReachOthersOn('anyone', 'imessage')).toBe(true);
  });

  it('the master switch governs the tier too — `all` under a false master is nothing', () => {
    agent('muted-all', (g) => { g.channels.master = false; g.channels.imessage = 'all'; });
    expect(mayReachOthersOn('muted-all', 'imessage')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5 · WHAT IT COSTS — stated as a test rather than only in a report
// ════════════════════════════════════════════════════════════════════════════════

describe('the narrowing, stated honestly', () => {
  it('⚠ THE `image_create` DOOR IS EMPTY-DIFF: the grant answers what the role did', () => {
    // Post-migration the primary is the only agent holding `imessage`, so this
    // one door changes no verdict for any agent alive — which is why it is the
    // auto-route door A4 could close for free.
    agent('primary');
    agent('other', (g) => { g.channels.master = false; });
    expect(mayUseChannel('primary', 'imessage')).toBe(true);
    expect(mayUseChannel('other', 'imessage')).toBe(false);
  });

  it('the AUTO-ROUTE door is NOT empty-diff, and the fix is a grant the owner can tick', () => {
    // HarnessBot's shape, reproduced: a ronin agent that auto-routed on iMessage
    // for weeks while holding `master:false`. Under A4 it is refused — and one
    // tick of the panel's iMessage control restores it, which is the whole point
    // of the section existing.
    agent('harnessbot', (g) => { g.channels.master = false; g.channels.imessage = 'none'; });
    expect(engineMayRouteTo('harnessbot', 'imessage')).toBe(false);

    db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(
      JSON.stringify({
        grants: (() => {
          const g = deriveLegacyGrants('harnessbot');
          g.channels.master = true;
          g.channels.imessage = 'owner';
          return g;
        })(),
      }),
      'harnessbot',
    );
    forgetAccessGrants();
    expect(engineMayRouteTo('harnessbot', 'imessage')).toBe(true);
  });

  it('a withheld route never deletes the reply — the dashboard destination is always open', () => {
    agent('harnessbot', (g) => { g.channels.master = false; });
    expect(engineMayRouteTo('harnessbot', 'imessage')).toBe(false);
    expect(engineMayRouteTo('harnessbot', 'dashboard')).toBe(true);
  });
});
