// UX-REPAIR ROUND 11 — T43a. THE DELEGATION DOOR STATES CAPABILITY.
//
// ── THE INCIDENT (round-11 S5-A) ─────────────────────────────────────────────────────────
// BehaviorBot called `list_agents` before delegating, got name/status/classification/group/
// activity and NOTHING about what any of them can do, and handed a WEB RESEARCH assignment to
// kelly — the PM, who has no web tools. She could only punt it to kevin, and the punt then
// satisfied her piece of the join (that half is T43b/c). The door the agent actually read
// before choosing an assignee did not carry the one fact the choice needed.
//
// ── STEP-0, RUN BEFORE ANY CODE (the task's own STOP gate) ────────────────────────────────
// "Derive from the REAL tool-grant source; STOP if per-agent tool grants are not derivable."
// They are. `agent/tools/surface.ts:getFilteredTools(agentId)` IS that source — the advertised
// list each agent is told about, after the permissions manifest, `tools_policy` allow/deny,
// account connectivity and the FA-TS2 primary-only strip. Measured on the dev body through
// that function, 2026-08-15, seven live agents:
//     Kevin 407 tools · Healer 242 · Ticky 241 · BehaviorBot 240 · Dreamer 168 ·
//     Imaginer 156 · KELLY 47 — and Kelly holds no tool from the declared `Web`,
//     `Communication`, `Gmail`, `Google Calendar` or `Google Drive / Docs / Sheets`
//     categories. The incident's premise is a property of the grants, and it is readable.
// VERDICT: PASS. Nothing here is hard-coded per agent; the tests below prove that by moving
// the grants and watching the line move with them.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t43a-list-agents-test', 'dojo.db'),
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
import { TOOL_CATEGORIES } from '../../../../tools/categories.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_SRC = fs.readFileSync(path.resolve(HERE, '../agents.ts'), 'utf8');

const PM = 'kelly';
const WORKER = 'kevin';

async function listAgents(verbose: boolean): Promise<string> {
  const h = agentsHandlers['list_agents'];
  const r = await h({
    agentId: 'behaviorbot', args: { verbose },
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
      group_id TEXT, last_error TEXT, last_error_at TEXT, created_at TEXT
    );
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, agent_id TEXT, created_at INTEGER);
  `);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO agents (id, name, status, classification, created_at) VALUES (?, 'Kelly', 'idle', 'sensei', ?)`).run(PM, now);
  db.prepare(`INSERT INTO agents (id, name, status, classification, created_at) VALUES (?, 'Kevin', 'idle', 'sensei', ?)`).run(WORKER, now);
  // The incident's real grant shape: the PM has the coordination verbs and nothing else.
  grants.set(PM, ['send_to_agent', 'work_open', 'work_update', 'list_agents']);
  grants.set(WORKER, [
    'send_to_agent', 'work_open', 'web_search', 'web_fetch', 'gmail_send',
    'calendar_create', 'drive_list', 'imessage_send',
  ]);
});

// ════════════════════════════════════════════════════════════════════════
// 1 — THE DOOR SAYS WHAT THE ASSIGNEE CAN DO. BOTH MODES.
// ════════════════════════════════════════════════════════════════════════

describe('list_agents carries capability, in both modes', () => {
  for (const verbose of [false, true]) {
    it(`${verbose ? 'verbose' : 'compact'}: the PM's line says she cannot do web research`, async () => {
      const out = await listAgents(verbose);
      const kelly = lineFor(out, 'Kelly');
      expect(kelly, 'the fact the delegation choice needed').toMatch(/web research/);
      expect(kelly, 'and it is stated as an ABSENCE, not left to inference').toMatch(/no:[^\n]*web research/);
    });

    it(`${verbose ? 'verbose' : 'compact'}: the capable worker's line says he CAN`, async () => {
      const out = await listAgents(verbose);
      const kevin = lineFor(out, 'Kevin');
      expect(kevin).toMatch(/can:[^\n]*web research/);
      expect(kevin, 'nothing on the delegable list is missing for him').not.toMatch(/no:/);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════
// 2 — DERIVED, NOT HARD-CODED. Move the grants; the line moves.
// ════════════════════════════════════════════════════════════════════════

describe('the line is derived from the real grant source', () => {
  it('granting the PM web tools flips her line, with no code change', async () => {
    grants.set(PM, ['send_to_agent', 'work_open', 'web_search']);
    const kelly = lineFor(await listAgents(false), 'Kelly');
    expect(kelly).toMatch(/can:[^\n]*web research/);
    expect(kelly, 'she still has no email/calendar/files/messaging').toMatch(/no:/);
  });

  it('revoking the worker\'s web tools flips HIS line, with no code change', async () => {
    grants.set(WORKER, ['send_to_agent', 'gmail_send']);
    const kevin = lineFor(await listAgents(false), 'Kevin');
    expect(kevin).toMatch(/no:[^\n]*web research/);
    expect(kevin).toMatch(/can:[^\n]*email/);
  });

  it('an agent with none of the delegable capabilities says so once, not five times', async () => {
    grants.set(PM, []);
    const kelly = lineFor(await listAgents(false), 'Kelly');
    expect(kelly).toMatch(/no: web research, email, calendar, files, messaging people/);
    expect(kelly).not.toMatch(/can:/);
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
// 3 — CONFORMANCE: the table points at REAL declared categories.
// ════════════════════════════════════════════════════════════════════════
//
// The capability table names `TOOL_CATEGORIES` labels rather than tool names, so a renamed
// category would silently resolve to an EMPTY tool set — and an empty set reads as "this
// agent cannot", for every agent, quietly. That is the one way this door can start lying, so
// it is a test rather than a comment.

describe('every category the capability table points at still exists', () => {
  const declared = new Set(TOOL_CATEGORIES.map((c) => c.label));

  it('resolves each referenced label, and the table is not typing tool names', () => {
    const block = AGENTS_SRC.slice(
      AGENTS_SRC.indexOf('const DELEGABLE_CAPABILITIES'),
      AGENTS_SRC.indexOf('/** capability label ->'),
    );
    expect(block.length, 'the table was found').toBeGreaterThan(100);
    const referenced = [...block.matchAll(/categories: \[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]));
    expect(referenced.length, 'every capability row names at least one category').toBeGreaterThanOrEqual(
      [...block.matchAll(/label: '/g)].length,
    );
    for (const label of referenced) {
      expect(declared.has(label), `"${label}" is a declared TOOL_CATEGORIES label`).toBe(true);
      const cat = TOOL_CATEGORIES.find((c) => c.label === label)!;
      expect(cat.tools.length, `"${label}" resolves to real tools`).toBeGreaterThan(0);
    }
  });

  it('and a tool from each referenced category really turns the clause positive', async () => {
    const labels = ['web research', 'email', 'calendar', 'files', 'messaging people'];
    for (const capLabel of labels) {
      // One representative tool per capability, taken from the DECLARED category lists.
      const rep: Record<string, string> = {
        'web research': 'web_search', email: 'outlook_send', calendar: 'calendar_agenda_ms',
        files: 'onedrive_list', 'messaging people': 'sms_send',
      };
      grants.set(PM, [rep[capLabel]]);
      const kelly = lineFor(await listAgents(false), 'Kelly');
      expect(kelly, `${capLabel} via ${rep[capLabel]}`).toMatch(
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
    const kelly = lineFor(await listAgents(false), 'Kelly');
    expect(kelly.startsWith(`- Kelly (${PM}), ready, sensei`)).toBe(true);
  });

  it('verbose still leads with name, ID:, status, classification', async () => {
    const kelly = lineFor(await listAgents(true), 'Kelly');
    expect(kelly.startsWith(`- Kelly (ID: ${PM}), ready, sensei`)).toBe(true);
  });

  it('the injured/paused warning still fires, unchanged', async () => {
    mockDb.current!.prepare(`UPDATE agents SET status='error', last_error='boom' WHERE id=?`).run(WORKER);
    const out = await listAgents(false);
    expect(out).toContain('agent(s) injured/paused');
    expect(lineFor(out, 'Kevin')).toContain('INJURED');
  });

  it('a group name still renders, and the capability clause does not displace it', async () => {
    mockDb.current!.prepare(`INSERT INTO agent_groups (id, name) VALUES ('g1', 'Research squad')`).run();
    mockDb.current!.prepare(`UPDATE agents SET group_id='g1' WHERE id=?`).run(WORKER);
    const kevin = lineFor(await listAgents(false), 'Kevin');
    expect(kevin).toContain('group: Research squad');
    expect(kevin).toMatch(/can:/);
  });
});
