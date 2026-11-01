// A tool added to a built-in agent's allow list must reach rows that already exist (the per-boot rewrite is retired), and
// must do it without touching anything an owner decided. The last block is the gate: it fails when a list gains a name
// that no release step delivers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { deliverPolicyTools, POLICY_DELIVERIES } from '../built-in-policy-delivery.js';
import { RELEASE_STEPS } from '../release-steps.js';
import { getAccessGrants } from '../../agent/access/read.js';
import { DREAMER_TOOLS_POLICY } from '../../vault/maintenance.js';
import { IMAGINER_TOOLS_POLICY } from '../../imaginer/imaginer-agent.js';
import { PM_ALLOWED_TOOLS } from '../../tracker/pm-agent.js';

const STEP = 'built-in-policy-tools';
const OLD_DREAMER = ['vault_remember', 'vault_search', 'complete_task'];
const grantsOf = (tools: object) => ({ grants: { v: 1, tools: { categories: '*', ...tools }, integrations: { plaud: true, credentials: true, google: { agent: 'none', user: 'none' }, microsoft: { agent: 'none', user: 'none' } }, channels: { master: null, imessage: 'none', sms: 'none', voice: 'none', email: 'none', teams: 'none' }, techniques: '*' } });

function addAgent(id: string, tools_policy: string | null, permissions: string | null) {
  mockDb.current!.prepare('INSERT INTO agents (id, tools_policy, permissions) VALUES (?, ?, ?)').run(id, tools_policy, permissions);
}
const row = (id: string) => mockDb.current!.prepare('SELECT tools_policy, permissions FROM agents WHERE id = ?').get(id) as { tools_policy: string | null; permissions: string | null };

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  mockDb.current.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, classification TEXT, tools_policy TEXT, permissions TEXT, updated_at TEXT)");
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('built-in agent tool delivery', () => {
  it('adds the missing tool to the column AND the stored grants, and the door then allows it', () => {
    const perm = { file_read: ['x'], ...grantsOf({ allow: OLD_DREAMER, deny: [] }) };
    addAgent('dreamer', JSON.stringify({ allow: OLD_DREAMER }), JSON.stringify(perm));
    const out = deliverPolicyTools(STEP);
    expect(out).toMatchObject({ examined: 1, repaired: 1, flagged: 0 });
    const r = row('dreamer');
    expect(JSON.parse(r.tools_policy!).allow).toEqual([...OLD_DREAMER, 'lesson_record']);
    expect(getAccessGrants('dreamer').tools.allow).toContain('lesson_record');
    expect(JSON.parse(r.permissions!).file_read).toEqual(['x']);          // the manifest beside the grants survives
  });

  it('is idempotent: a second pass changes nothing', () => {
    addAgent('dreamer', JSON.stringify({ allow: OLD_DREAMER }), JSON.stringify(grantsOf({ allow: OLD_DREAMER, deny: [] })));
    deliverPolicyTools(STEP);
    const first = row('dreamer');
    expect(deliverPolicyTools(STEP).repaired).toBe(0);
    expect(row('dreamer')).toEqual(first);
  });

  it('a tool the owner denied stays denied and is not added', () => {
    const perm = grantsOf({ allow: OLD_DREAMER, deny: ['lesson_record'] });
    addAgent('dreamer', JSON.stringify({ allow: OLD_DREAMER, deny: ['lesson_record'] }), JSON.stringify(perm));
    expect(deliverPolicyTools(STEP).repaired).toBe(0);
    expect(JSON.parse(row('dreamer').tools_policy!).allow).toEqual(OLD_DREAMER);
    expect(getAccessGrants('dreamer').tools.allow).not.toContain('lesson_record');
  });

  it('never removes or reorders an owner addition', () => {
    const owner = ['file_list', ...OLD_DREAMER, 'web_fetch'];
    addAgent('dreamer', JSON.stringify({ allow: owner, deny: ['exec'], extra: 1 }), null);
    deliverPolicyTools(STEP);
    expect(JSON.parse(row('dreamer').tools_policy!)).toEqual({ allow: [...owner, 'lesson_record'], deny: ['exec'], extra: 1 });
  });

  it('an empty or absent allow list means unrestricted and is left alone', () => {
    addAgent('dreamer', JSON.stringify({ allow: [] }), JSON.stringify(grantsOf({ allow: [], deny: [] })));
    addAgent('pm', JSON.stringify({ deny: ['x'] }), null);
    const before = [row('dreamer'), row('pm')];
    expect(deliverPolicyTools(STEP).repaired).toBe(0);
    expect([row('dreamer'), row('pm')]).toEqual(before);
  });

  it('a column with no stored grants is still updated (the fallback derives from it)', () => {
    addAgent('pm', JSON.stringify({ allow: ['list_agents'] }), '{}');
    deliverPolicyTools(STEP);
    expect(JSON.parse(row('pm').tools_policy!).allow).toEqual(['list_agents', 'tool_result_read']);
    expect(row('pm').permissions).toBe('{}');
  });

  it('malformed policy or permissions is left exactly as it is, reported, and does not throw', () => {
    addAgent('dreamer', '{not json', '[also bad');
    addAgent('pm', '"a string"', '{"grants":5}');
    let out!: ReturnType<typeof deliverPolicyTools>;
    expect(() => { out = deliverPolicyTools(STEP); }).not.toThrow();
    expect(out.repaired).toBe(0);
    expect(out.flagged).toBeGreaterThan(0);
    expect(row('dreamer')).toEqual({ tools_policy: '{not json', permissions: '[also bad' });
    expect(row('pm')).toEqual({ tools_policy: '"a string"', permissions: '{"grants":5}' });
  });

  it('a malformed Dreamer does not stop the PM being delivered', () => {
    addAgent('dreamer', '{not json', null);
    addAgent('pm', JSON.stringify({ allow: ['list_agents'] }), null);
    deliverPolicyTools(STEP);
    expect(JSON.parse(row('pm').tools_policy!).allow).toContain('tool_result_read');
  });

  it('a box without the agents does nothing', () => {
    expect(deliverPolicyTools(STEP)).toEqual({ examined: 0, flagged: 0, repaired: 0 });
  });
});

// ── THE GATE ──
// Names a row could already hold before the per-boot rewrites were retired (v3.1.22's lists). Every name the code lists
// today must be one of these or be delivered by a release step. Do not extend BASELINE to make this pass: add a
// POLICY_DELIVERIES entry and a step instead.
const BASELINE: Record<string, string[]> = {
  dreamer: ['vault_remember', 'vault_search', 'vault_forget', 'vault_discard_archives', 'history_search', 'history_get',
    'contact_remember', 'contact_search', 'credential_add', 'credential_list', 'file_read', 'file_write',
    'work_open', 'work_update', 'work_note', 'get_current_time', 'load_tool_docs', 'complete_task'],
  pm: ['work_update', 'work_note', 'work_schedule', 'work_validate', 'work_close_request',
    'send_to_agent', 'broadcast_to_group', 'list_agents', 'list_groups', 'vault_search', 'vault_get', 'vault_remember',
    'history_search', 'history_get', 'load_tool_docs', 'get_current_time', 'file_read', 'file_list'],
  imaginer: ['load_tool_docs', 'complete_task', 'get_current_time', 'send_to_agent', 'list_agents'],
};

describe('a tool added to a built-in agent list is delivered to existing rows', () => {
  const lists: Record<string, string[]> = {
    dreamer: JSON.parse(DREAMER_TOOLS_POLICY).allow,
    pm: [...PM_ALLOWED_TOOLS],
    imaginer: JSON.parse(IMAGINER_TOOLS_POLICY).allow,
  };
  for (const [agent, allow] of Object.entries(lists)) {
    it(`${agent}: every listed tool is in the baseline or delivered by a release step`, () => {
      const delivered = POLICY_DELIVERIES.filter((d) => d.agent === agent).map((d) => d.tool);
      const undelivered = allow.filter((t) => !BASELINE[agent].includes(t) && !delivered.includes(t));
      expect(undelivered, `add ${undelivered.join(', ')} to POLICY_DELIVERIES with a release step`).toEqual([]);
    });
  }
  it('every delivery names a release step that exists and a tool the list really holds', () => {
    for (const d of POLICY_DELIVERIES) {
      expect(RELEASE_STEPS.map((s) => s.id), `${d.tool}: no such step`).toContain(d.stepId);
      expect(lists[d.agent], `${d.tool} is no longer in the ${d.agent} list`).toContain(d.tool);
    }
  });
});
