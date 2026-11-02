// A built-in agent whose row was last machine-written by an old build can lack tools the code lists have gained since. No
// signal in the product tells an owner's trim from a name that never arrived, so the upgrade never edits the list: it tells
// the owner once, on a dashboard card, and the owner decides. These cases pin that: nothing in a row ever changes, a trimmed
// row is never given a name back, a denied name is never offered, and a box that already holds everything sees no card.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
const notices: Array<{ toAgentId: string; brief: string }> = [];
vi.mock('../../agent/agent-notice.js', () => ({
  postAgentNotice: (o: { toAgentId: string; brief: string }) => { notices.push(o); return 'id'; },
}));

import { raiseBuiltInToolsGap } from '../built-in-tools-gap.js';
import { builtInToolsOwnerCards } from '../../services/built-in-tools-card.js';
import { RELEASE_STEPS } from '../release-steps.js';
import { DREAMER_TOOLS_POLICY } from '../../vault/maintenance.js';
import { PM_ALLOWED_TOOLS } from '../../tracker/pm-agent.js';

const DREAMER = JSON.parse(DREAMER_TOOLS_POLICY).allow as string[];
const PM = [...PM_ALLOWED_TOOLS];
// What a PM last written before the verb collapse and the validator joined the list held (old alias names on purpose).
const PM_OLD = ['tracker_list_projects', 'tracker_get', 'send_to_agent', 'list_agents', 'vault_search', 'get_current_time'];
const grantsOf = (tools: object) => ({ grants: { v: 1, tools: { categories: '*', ...tools }, integrations: { plaud: true, credentials: true, google: { agent: 'none', user: 'none' }, microsoft: { agent: 'none', user: 'none' } }, channels: { master: null, imessage: 'none', sms: 'none', voice: 'none', email: 'none', teams: 'none' }, techniques: '*' } });

function addAgent(id: string, name: string, tools_policy: string | null, permissions: string | null) {
  mockDb.current!.prepare('INSERT INTO agents (id, name, tools_policy, permissions) VALUES (?, ?, ?, ?)').run(id, name, tools_policy, permissions);
}
const rows = () => mockDb.current!.prepare('SELECT id, tools_policy, permissions, updated_at FROM agents ORDER BY id').all();
const cards = () => builtInToolsOwnerCards();

beforeEach(() => {
  notices.length = 0;
  mockDb.current = new Database(':memory:');
  mockDb.current.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  mockDb.current.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, classification TEXT, tools_policy TEXT, permissions TEXT, updated_at TEXT)');
  addAgent('primary', 'Main', null, null);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a built-in agent that lacks tools the code lists have gained', () => {
  it('an untouched old PM: the owner gets one card naming what is missing, and the row is not edited', () => {
    addAgent('pm', 'Boss', JSON.stringify({ allow: PM_OLD }), JSON.stringify(grantsOf({ allow: PM_OLD, deny: [] })));
    const before = rows();
    const out = raiseBuiltInToolsGap();
    expect(out).toMatchObject({ examined: 1, flagged: 1, repaired: 0 });
    expect(rows()).toEqual(before);                                   // byte-identical: nothing is ever added by this step
    const [card] = cards();
    expect(card.words.startsWith('Dojo:')).toBe(true);
    expect(card.words).toContain('work_validate');
    expect(card.words).toContain('Boss');
    expect(card.words).not.toContain('tracker_get');                  // held (as its replacement), so not offered
    expect(card.words).not.toContain('send_to_agent');
  });

  it('the main agent is told exactly what the card says, once', () => {
    addAgent('pm', 'Boss', JSON.stringify({ allow: PM_OLD }), null);
    raiseBuiltInToolsGap();
    raiseBuiltInToolsGap();
    expect(notices).toHaveLength(1);
    expect(notices[0].toAgentId).toBe('primary');
    expect(notices[0].brief).toContain(cards()[0].words);
  });

  it('an owner-trimmed row is never given a name back; the card only offers, and dismissing ends it for good', () => {
    const trimmed = PM.filter((t) => t !== 'file_read' && t !== 'file_list' && t !== 'vault_get');
    addAgent('pm', 'Boss', JSON.stringify({ allow: trimmed }), JSON.stringify(grantsOf({ allow: trimmed, deny: [] })));
    const before = rows();
    raiseBuiltInToolsGap();
    expect(rows()).toEqual(before);
    expect(cards()).toHaveLength(1);
    cards()[0].dismiss();
    expect(cards()).toHaveLength(0);
    raiseBuiltInToolsGap();                                           // a later boot, a re-upgrade: still dismissed
    expect(cards()).toHaveLength(0);
    expect(rows()).toEqual(before);
  });

  it('a name the owner denied (in either place) is never offered', () => {
    addAgent('pm', 'Boss', JSON.stringify({ allow: PM_OLD, deny: ['work_validate'] }), JSON.stringify(grantsOf({ allow: PM_OLD, deny: ['vault_get'] })));
    raiseBuiltInToolsGap();
    const words = cards()[0].words;
    expect(words).not.toContain('work_validate');
    expect(words).not.toContain('vault_get');
    expect(words).toContain('work_close_request');
  });

  it('a current box (every listed tool held) sees no card, no note, no record, and no change', () => {
    addAgent('pm', 'Boss', JSON.stringify({ allow: PM }), JSON.stringify(grantsOf({ allow: PM, deny: [] })));
    addAgent('dreamer', 'Curator', JSON.stringify({ allow: DREAMER }), JSON.stringify(grantsOf({ allow: DREAMER, deny: [] })));
    const before = rows();
    expect(raiseBuiltInToolsGap()).toMatchObject({ examined: 2, flagged: 0 });
    expect(cards()).toEqual([]);
    expect(notices).toEqual([]);
    expect(rows()).toEqual(before);
    expect(mockDb.current!.prepare('SELECT COUNT(*) AS n FROM config').get()).toEqual({ n: 0 });
  });

  it('judges the stored grants, which are the authority, not a stale column', () => {
    addAgent('pm', 'Boss', JSON.stringify({ allow: PM }), JSON.stringify(grantsOf({ allow: PM.filter((t) => t !== 'vault_get'), deny: [] })));
    raiseBuiltInToolsGap();
    expect(cards()[0].words).toContain('vault_get');
  });

  it('an unrestricted agent (empty or absent allow) and a missing agent are left alone', () => {
    addAgent('pm', 'Boss', JSON.stringify({ allow: [] }), null);
    expect(raiseBuiltInToolsGap()).toMatchObject({ flagged: 0 });
    expect(cards()).toEqual([]);
  });

  it('a row that does not parse is left as it is and raises nothing', () => {
    addAgent('pm', 'Boss', '{not json', '[bad');
    addAgent('dreamer', 'Curator', '"x"', '{"grants":5}');
    const before = rows();
    expect(() => raiseBuiltInToolsGap()).not.toThrow();
    expect(rows()).toEqual(before);
    expect(cards()).toEqual([]);
  });

  it('the card ends when the owner adds the tools through the policy path; a later trim raises nothing new', () => {
    addAgent('pm', 'Boss', JSON.stringify({ allow: PM_OLD }), JSON.stringify(grantsOf({ allow: PM_OLD, deny: [] })));
    raiseBuiltInToolsGap();
    expect(cards()).toHaveLength(1);
    mockDb.current!.prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify(grantsOf({ allow: PM, deny: [] })), 'pm');
    expect(cards()).toEqual([]);
    mockDb.current!.prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify(grantsOf({ allow: PM_OLD, deny: [] })), 'pm');
    raiseBuiltInToolsGap();                                           // the owner's own trim after the fact: the record stands, not re-raised
    expect(notices).toHaveLength(1);
  });

  it('an unreadable database throws so the runner keeps the step owed; it never edits an agent', () => {
    mockDb.current!.exec('DROP TABLE agents');
    expect(() => raiseBuiltInToolsGap()).toThrow();
  });
});

describe('the step', () => {
  it('is a release step that runs after the delivery step and calls this pass', () => {
    const ids = RELEASE_STEPS.map((s) => s.id);
    expect(ids.indexOf('built-in-tools-gap')).toBeGreaterThan(ids.indexOf('built-in-policy-tools'));
    const step = RELEASE_STEPS.find((s) => s.id === 'built-in-tools-gap')!;
    expect(step.sinceVersion).toBe('3.5.0-0');
    expect(String(step.run)).toMatch(/raiseBuiltInToolsGap/);
  });
});
