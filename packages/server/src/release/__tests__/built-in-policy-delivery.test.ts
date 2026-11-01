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
import { canonicalizeToolsPolicy } from '../../agent/access/tools-policy.js';
import { DREAMER_TOOLS_POLICY } from '../../vault/maintenance.js';
import { PM_ALLOWED_TOOLS } from '../../tracker/pm-agent.js';

const STEP = 'built-in-policy-tools';
// Today's lists minus the one newest tool, so these cases isolate that tool (the alias/old-row cases below cover the rest).
const OLD_DREAMER = (JSON.parse(DREAMER_TOOLS_POLICY).allow as string[]).filter((t) => t !== 'lesson_record');
const OLD_PM = PM_ALLOWED_TOOLS.filter((t) => t !== 'tool_result_read');
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
    addAgent('pm', JSON.stringify({ allow: OLD_PM }), '{}');
    deliverPolicyTools(STEP);
    expect(JSON.parse(row('pm').tools_policy!).allow).toEqual([...OLD_PM, 'tool_result_read']);
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

  it('a denial in the grants alone also keeps the column from gaining the tool', () => {
    addAgent('dreamer', JSON.stringify({ allow: OLD_DREAMER }), JSON.stringify(grantsOf({ allow: OLD_DREAMER, deny: ['lesson_record'] })));
    expect(deliverPolicyTools(STEP).repaired).toBe(0);
    expect(JSON.parse(row('dreamer').tools_policy!).allow).toEqual(OLD_DREAMER);
  });

  it('a row holding old alias names already holds their replacements; only the genuinely new names arrive', () => {
    const old = ['vault_remember', 'memory_grep', 'memory_describe', 'tracker_add_notes', 'tracker_create_task', 'complete_task'];
    addAgent('dreamer', JSON.stringify({ allow: old }), null);
    deliverPolicyTools(STEP);
    const got = JSON.parse(row('dreamer').tools_policy!).allow as string[];
    expect(got.slice(0, old.length)).toEqual(old);
    for (const t of ['history_search', 'history_get', 'work_note', 'work_open']) expect(got, t).not.toContain(t);
    for (const t of ['vault_discard_archives', 'contact_remember', 'credential_add', 'lesson_record']) expect(got, t).toContain(t);
  });

  it('an old PM row (v1.0.0 names) ends holding every tool the current PM list has', () => {
    addAgent('pm', JSON.stringify({ allow: ['tracker_list_active', 'tracker_update_status', 'tracker_add_notes', 'tracker_pause_schedule', 'send_to_agent', 'list_agents', 'list_groups', 'get_current_time', 'imessage_send'] }), null);
    deliverPolicyTools(STEP);
    const held = new Set(canonicalizeToolsPolicy({ allow: JSON.parse(row('pm').tools_policy!).allow, deny: [] }).allow);
    for (const t of PM_ALLOWED_TOOLS) expect(held.has(t), t).toBe(true);
  });


  it('a box without the agents does nothing', () => {
    expect(deliverPolicyTools(STEP)).toEqual({ examined: 0, flagged: 0, repaired: 0 });
  });
});

// ── THE GATE ──
// Canonical names a row of the OLDEST persistent Dreamer (v1.15.18) and PM (v1.0.0) held; every other name in today's
// lists must be delivered by a release step. Do not extend BASELINE to make this pass: add a POLICY_DELIVERIES entry
// under a NEW step id (a step that has shipped never runs again on a box that has passed it).
const BASELINE: Record<string, string[]> = {
  dreamer: ['vault_remember', 'vault_search', 'vault_forget', 'history_search', 'history_get', 'file_read', 'file_write',
    'work_open', 'work_update', 'work_note', 'get_current_time', 'load_tool_docs', 'complete_task'],
  pm: ['work_update', 'work_note', 'work_schedule', 'send_to_agent', 'list_agents', 'list_groups', 'get_current_time'],
};

// The tools each step delivers, pinned. Once a release carrying a step is published its set is frozen: a tool added later
// needs its own step id, or boxes already past the step never receive it.
const PINNED_STEPS: Record<string, string[]> = {
  'built-in-policy-tools': [
    'dreamer:contact_remember', 'dreamer:contact_search', 'dreamer:credential_add', 'dreamer:credential_list',
    'dreamer:lesson_record', 'dreamer:vault_discard_archives',
    'pm:broadcast_to_group', 'pm:file_list', 'pm:file_read', 'pm:history_get', 'pm:history_search', 'pm:load_tool_docs',
    'pm:tool_result_read', 'pm:vault_get', 'pm:vault_remember', 'pm:vault_search', 'pm:work_close_request', 'pm:work_validate',
  ],
};

describe('a tool added to a built-in agent list is delivered to existing rows', () => {
  const lists: Record<string, string[]> = {
    dreamer: JSON.parse(DREAMER_TOOLS_POLICY).allow,
    pm: [...PM_ALLOWED_TOOLS],
  };
  for (const [agent, allow] of Object.entries(lists)) {
    it(`${agent}: every listed tool is in the baseline or delivered by a release step`, () => {
      const delivered = POLICY_DELIVERIES.filter((d) => d.agent === agent).map((d) => d.tool);
      const undelivered = allow.filter((t) => !BASELINE[agent].includes(t) && !delivered.includes(t));
      expect(undelivered, `add ${undelivered.join(', ')} to POLICY_DELIVERIES under a new step`).toEqual([]);
    });
  }
  it('every delivery names a release step that exists and a tool the list really holds', () => {
    for (const d of POLICY_DELIVERIES) {
      expect(RELEASE_STEPS.map((s) => s.id), `${d.tool}: no such step`).toContain(d.stepId);
      expect(lists[d.agent], `${d.tool} is no longer in the ${d.agent} list`).toContain(d.tool);
    }
  });
  it('each step delivers exactly its pinned set (a shipped step never gains a tool)', () => {
    const byStep: Record<string, string[]> = {};
    for (const d of POLICY_DELIVERIES) (byStep[d.stepId] ??= []).push(`${d.agent}:${d.tool}`);
    for (const k of Object.keys(byStep)) byStep[k].sort();
    expect(byStep).toEqual(PINNED_STEPS);
  });
  it('a step that delivers calls deliverPolicyTools with its own id', () => {
    for (const id of new Set(POLICY_DELIVERIES.map((d) => d.stepId))) {
      const step = RELEASE_STEPS.find((s) => s.id === id)!;
      expect(String(step.run), id).toMatch(new RegExp(`deliverPolicyTools\\(\\s*['"]${id}['"]\\s*\\)`));
    }
  });
});
