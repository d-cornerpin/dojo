// UX-REPAIR ROUND 11 — T43a. THE DELEGATION DOOR STATES CAPABILITY.
//
// ── THE INCIDENT (round-11 S5-A) ─────────────────────────────────────────────────────────
// HarnessBot called `list_agents` before delegating, got name/status/classification/group/
// activity and NOTHING about what any of them can do, and handed a WEB RESEARCH assignment to
// FXID.n5 — the PM, who has no web tools. She could only punt it to FXID.n4, and the punt then
// satisfied her piece of the join (that half is T43b/c). The door the agent actually read
// before choosing an assignee did not carry the one fact the choice needed.
//
// ── STEP-0, RUN BEFORE ANY CODE (the task's own STOP gate) ────────────────────────────────
// "Derive from the REAL tool-grant source; STOP if per-agent tool grants are not derivable."
// They are. `agent/tools/surface.ts:getFilteredTools(agentId)` IS that source — the advertised
// list each agent is told about, after the permissions manifest, `tools_policy` allow/deny,
// account connectivity and the FA-TS2 primary-only strip. Measured on the dev body through
// that function, 2026-08-15, seven live agents:
//     FX.n4 407 tools · Healer 242 · FX.n6 241 · HarnessBot 240 · Dreamer 168 ·
//     FXUP.n5 47 — and FX.n5 holds no tool from the declared `Web`,
//     `Communication`, `Gmail`, `Google Calendar` or `Google Drive / Docs / Sheets`
//     categories. The incident's premise is a property of the grants, and it is readable.
// VERDICT: PASS. Nothing here is hard-coded per agent; the tests below prove that by moving
// the grants and watching the line move with them.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

/** The grant source, under the test's control. Keyed by agent id -> tool names. */
const grants: Map<string, string[]> = new Map();

vi.mock('../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t43a-list-agents-test', 'dojo.db'),
  };
});

// The REAL grant source, stubbed at its own module so this suite drives the door and not
// ~185 account scans per agent. `capability-line.test`-style coupling is deliberate: what is
// asserted below is that the door reads THIS function, whatever it answers.
vi.mock('../../surface.js', () => ({
  getFilteredTools: (agentId: string) => (grants.get(agentId) ?? []).map((name) => ({ name })),
}));

vi.mock('../../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { agentsHandlers } from '../agents.js';
import { forgetAccessGrants } from '../../../access/read.js';
import { FX, FXID } from '../../../../../../../deploy/checks/fixture-vocabulary.mjs';

const PM = FXID.n5;
const WORKER = FXID.n4;

async function listAgents(verbose: boolean): Promise<string> {
  const h = agentsHandlers['list_agents'];
  const r = await h({
    agentId: 'harnessbot', args: { verbose },
  } as unknown as Parameters<typeof h>[0]);
  return r.content;
}

/** The line the door prints for one agent, whichever mode is running. */
const lineFor = (out: string, name: string): string =>
  out.split('\n').find((l) => l.includes(name)) ?? '';

beforeEach(() => {
  grants.clear();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, classification TEXT,
      group_id TEXT, last_error TEXT, last_error_at TEXT, created_at TEXT,
      permissions TEXT DEFAULT '{}', tools_policy TEXT DEFAULT '{}'
    );
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, agent_id TEXT, created_at INTEGER);
  `);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO agents (id, name, status, classification, created_at) VALUES (?, '${FX.n5}', 'idle', 'sensei', ?)`).run(PM, now);
  db.prepare(`INSERT INTO agents (id, name, status, classification, created_at) VALUES (?, '${FX.n4}', 'idle', 'sensei', ?)`).run(WORKER, now);
  // The incident's real grant shape: the PM has the coordination verbs and nothing else.
  grants.set(PM, ['send_to_agent', 'work_open', 'work_update', 'list_agents']);
  grants.set(WORKER, [
    'send_to_agent', 'work_open', 'web_search', 'web_fetch', 'gmail_send',
    'calendar_create', 'drive_list', 'imessage_send',
  ]);
  // UX-ACCESS A2. The `messaging people` row is the one capability whose wall is
  // a CHANNEL GRANT rather than the advertised surface, so the fixture has to
  // state it — which is the point, not an inconvenience: before A2 this file
  // could say FX.n4 "can: messaging people" using nothing but a tool name, and
  // the door that actually runs `imessage_send` would have refused him.
  forgetAccessGrants();
  setChannels(WORKER, true);
});

/** Write (or clear) the human-channel grant for one agent, through the stored
 *  object every door reads. */
function setChannels(agentId: string, on: boolean): void {
  mockDb.current!.prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(
    JSON.stringify({
      grants: {
        v: 1,
        tools: { categories: '*', allow: [], deny: [] },
        integrations: { plaud: true, credentials: '*', google: { agent: 'full', user: 'full' }, microsoft: { agent: 'full', user: 'full' } },
        channels: on
          ? { master: true, imessage: 'all', sms: 'all', voice: 'all', email: 'all', teams: 'all' }
          : { master: false, imessage: 'none', sms: 'none', voice: 'none', email: 'none', teams: 'none' },
      },
    }),
    agentId,
  );
  forgetAccessGrants();
}

// ════════════════════════════════════════════════════════════════════════
// 1 — THE DOOR SAYS WHAT THE ASSIGNEE CAN DO. BOTH MODES.
// ════════════════════════════════════════════════════════════════════════

describe('list_agents carries capability, in both modes', () => {
  for (const verbose of [false, true]) {
    it(`${verbose ? 'verbose' : 'compact'}: the PM's line says she cannot do web research`, async () => {
      const out = await listAgents(verbose);
      const lineN5 = lineFor(out, FX.n5);
      expect(lineN5, 'the fact the delegation choice needed').toMatch(/web research/);
      expect(lineN5, 'and it is stated as an ABSENCE, not left to inference').toMatch(/no:[^\n]*web research/);
    });

    it(`${verbose ? 'verbose' : 'compact'}: the capable worker's line says he CAN`, async () => {
      const out = await listAgents(verbose);
      const lineN4 = lineFor(out, FX.n4);
      expect(lineN4).toMatch(/can:[^\n]*web research/);
      expect(lineN4, 'nothing on the delegable list is missing for him').not.toMatch(/no:/);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════
// 2 — DERIVED, NOT HARD-CODED. Move the grants; the line moves.
// ════════════════════════════════════════════════════════════════════════

describe('the line is derived from the real grant source', () => {
  it('granting the PM web tools flips her line, with no code change', async () => {
    grants.set(PM, ['send_to_agent', 'work_open', 'web_search']);
    const lineN5 = lineFor(await listAgents(false), FX.n5);
    expect(lineN5).toMatch(/can:[^\n]*web research/);
    expect(lineN5, 'she still has no email/calendar/files/messaging').toMatch(/no:/);
  });

  it('revoking the worker\'s web tools flips HIS line, with no code change', async () => {
    grants.set(WORKER, ['send_to_agent', 'gmail_send']);
    const lineN4 = lineFor(await listAgents(false), FX.n4);
    expect(lineN4).toMatch(/no:[^\n]*web research/);
    expect(lineN4).toMatch(/can:[^\n]*email/);
  });

  it('an agent with none of the delegable capabilities says so once, not five times', async () => {
    grants.set(PM, []);
    const lineN5 = lineFor(await listAgents(false), FX.n5);
    expect(lineN5).toMatch(/no: web research, email, calendar, files, messaging people/);
    expect(lineN5).not.toMatch(/can:/);
  });

  it('the door reads getFilteredTools — a grant list nobody seeded reads as no capability', async () => {
    mockDb.current!.prepare(
      `INSERT INTO agents (id, name, status, classification, created_at) VALUES ('ghost', 'Ghost', 'idle', 'ronin', ?)`,
    ).run(new Date().toISOString());
    const ghost = lineFor(await listAgents(false), 'Ghost');
    expect(ghost).toMatch(/no: web research, email, calendar, files, messaging people/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2b — UX-ACCESS A2: THE LINE MATCHES THE WALL, NOT JUST THE SURFACE.
// ════════════════════════════════════════════════════════════════════════
//
// A1 left the channel walls reading grants while the ADVERTISED surface still
// offers `imessage_send` to every agent (its §6.5: stripping it by grant would
// have moved ~110 tool indexes, a prompt change A1 would not make). So a clause
// derived from the surface alone told a delegator "can: messaging people" about
// an agent the door refuses — the T43a incident with the sign flipped, and the
// reason A2 owns "capability lines derive from GRANTS".

describe('a capability the door gates on a CHANNEL needs the channel grant', () => {
  it('⚠ ADVERTISED `imessage_send` + NO CHANNEL GRANT READS AS CANNOT', async () => {
    setChannels(WORKER, false);
    const lineN4 = lineFor(await listAgents(false), FX.n4);
    expect(lineN4, 'the surface still advertises it').toContain(FX.n4);
    expect(lineN4).toMatch(/no:[^\n]*messaging people/);
    expect(lineN4, 'and the surface-derived capabilities are unaffected').toMatch(/can:[^\n]*web research/);
  });

  it('the grant flips it back, with no change to the advertised list', async () => {
    setChannels(WORKER, true);
    expect(lineFor(await listAgents(false), FX.n4)).toMatch(/can:[^\n]*messaging people/);
  });

  it('THE CONTROL: the grant alone is not enough — the tool must be advertised too', async () => {
    setChannels(PM, true);
    expect(lineFor(await listAgents(false), FX.n5)).toMatch(/no:[^\n]*messaging people/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3 — CONFORMANCE: the table points at REAL declared categories.
// ════════════════════════════════════════════════════════════════════════
//
// The capability table names `TOOL_CATEGORIES` labels rather than tool names, so a renamed
// category would silently resolve to an EMPTY tool set — and an empty set reads as "this
// agent cannot", for every agent, quietly. That is the one way this door can start lying, so
// it is a test rather than a comment.

describe('every category the capability table points at still exists', () => {

  it('and a tool from each referenced category really turns the clause positive', async () => {
    const labels = ['web research', 'email', 'calendar', 'files', 'messaging people'];
    for (const capLabel of labels) {
      // One representative tool per capability, taken from the DECLARED category lists.
      const rep: Record<string, string> = {
        'web research': 'web_search', email: 'outlook_send', calendar: 'calendar_agenda_ms',
        files: 'onedrive_list', 'messaging people': 'sms_send',
      };
      grants.set(PM, [rep[capLabel]]);
      // A2: `messaging people` also needs the channel grant its wall reads.
      if (capLabel === 'messaging people') setChannels(PM, true);
      const lineN5 = lineFor(await listAgents(false), FX.n5);
      expect(lineN5, `${capLabel} via ${rep[capLabel]}`).toMatch(
        new RegExp(`can: ${capLabel.replace(/ /g, ' ')}(;|$)`),
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4 — NOTHING ELSE ON THE LINE MOVED (the door's existing contract).
// ════════════════════════════════════════════════════════════════════════

describe('the rest of the door is untouched', () => {
  it('compact still leads with name, id, status, classification', async () => {
    const lineN5 = lineFor(await listAgents(false), FX.n5);
    expect(lineN5.startsWith(`- ${FX.n5} (${PM}), ready, sensei`)).toBe(true);
  });

  it('verbose still leads with name, ID:, status, classification', async () => {
    const lineN5 = lineFor(await listAgents(true), FX.n5);
    expect(lineN5.startsWith(`- ${FX.n5} (ID: ${PM}), ready, sensei`)).toBe(true);
  });

  it('the injured/paused warning still fires, unchanged', async () => {
    mockDb.current!.prepare(`UPDATE agents SET status='error', last_error='boom' WHERE id=?`).run(WORKER);
    const out = await listAgents(false);
    expect(out).toContain('agent(s) injured/paused');
    expect(lineFor(out, FX.n4)).toContain('INJURED');
  });

  it('a group name still renders, and the capability clause does not displace it', async () => {
    mockDb.current!.prepare(`INSERT INTO agent_groups (id, name) VALUES ('g1', 'Research squad')`).run();
    mockDb.current!.prepare(`UPDATE agents SET group_id='g1' WHERE id=?`).run(WORKER);
    const lineN4 = lineFor(await listAgents(false), FX.n4);
    expect(lineN4).toContain('group: Research squad');
    expect(lineN4).toMatch(/can:/);
  });
});
