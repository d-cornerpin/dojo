// After an update the Dreamer and PM gain the tool their build added (in the column and the grants), never one the owner
// denied or a name an owner may have trimmed; an older listed tool still missing is offered once on a card.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));
const notices: Array<{ toAgentId: string; brief: string }> = [];
vi.mock('../../agent/agent-notice.js', () => ({
  postAgentNotice: (o: { toAgentId: string; brief: string }) => { notices.push(o); return 'id'; },
}));

import { RELEASE_STEPS } from '../release-steps.js';
import { getAccessGrants } from '../../agent/access/read.js';
import { dismissOwnerNotice } from '../../healer/owner-notices.js';
import { standingOwnerNotices } from '../../healer/owner-notice-kinds.js';
import { DREAMER_TOOLS_POLICY } from '../../vault/maintenance.js';
import { PM_ALLOWED_TOOLS } from '../../tracker/pm-agent.js';

const DREAMER = JSON.parse(DREAMER_TOOLS_POLICY).allow as string[];
const OLD_DREAMER = DREAMER.filter((t) => t !== 'lesson_record');
const PM = [...PM_ALLOWED_TOOLS];
const OLD_PM = PM.filter((t) => t !== 'tool_result_read');
// What a PM written before the verb collapse held (old alias names on purpose).
const ANCIENT_PM = ['tracker_list_projects', 'tracker_get', 'send_to_agent', 'list_agents', 'vault_search', 'get_current_time'];
const grantsOf = (tools: object) => ({ grants: { v: 1, tools: { categories: '*', ...tools }, integrations: { plaud: true, credentials: true, google: { agent: 'none', user: 'none' }, microsoft: { agent: 'none', user: 'none' } }, channels: { master: null, imessage: 'none', sms: 'none', voice: 'none', email: 'none', teams: 'none' }, techniques: '*' } });

const step = RELEASE_STEPS.find((s) => s.id === 'built-in-tools')!;
const run = () => step.run() as Promise<{ examined: number; flagged: number; repaired: number }>;
function addAgent(id: string, name: string, allow: string[], deny: string[] = [], grantsDeny: string[] = []) {
  mockDb.current!.prepare('INSERT INTO agents (id, name, tools_policy, permissions) VALUES (?, ?, ?, ?)')
    .run(id, name, JSON.stringify({ allow, deny }), JSON.stringify({ file_read: ['x'], ...grantsOf({ allow, deny: grantsDeny }) }));
}
const row = (id: string) => mockDb.current!.prepare('SELECT tools_policy, permissions FROM agents WHERE id = ?').get(id) as { tools_policy: string; permissions: string };
const cards = () => standingOwnerNotices().filter((c) => c.cardKey.startsWith('built-in-tools:'));

beforeEach(() => {
  notices.length = 0;
  mockDb.current = new Database(':memory:');
  mockDb.current.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  mockDb.current.exec('CREATE TABLE healer_state (scope TEXT, key TEXT, at_ms INTEGER, value TEXT, updated_at TEXT, PRIMARY KEY (scope, key))');
  mockDb.current.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'idle', classification TEXT, tools_policy TEXT, permissions TEXT, updated_at TEXT)");
  mockDb.current.prepare("INSERT INTO agents (id, name) VALUES ('primary', 'Main')").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('an upgraded built-in agent gets its new tool, or one card', () => {
  it('adds the new tool to the column and the grants, the door allows it, and a second pass changes nothing', async () => {
    addAgent('dreamer', 'Curator', OLD_DREAMER);
    addAgent('pm', 'Boss', OLD_PM);
    expect(await run()).toMatchObject({ examined: 2, repaired: 2, flagged: 0 });
    expect(JSON.parse(row('dreamer').tools_policy).allow).toEqual([...OLD_DREAMER, 'lesson_record']);
    expect(getAccessGrants('dreamer').tools.allow).toContain('lesson_record');
    expect(getAccessGrants('pm').tools.allow).toContain('tool_result_read');
    expect(JSON.parse(row('dreamer').permissions).file_read).toEqual(['x']);
    const first = [row('dreamer'), row('pm')];
    expect((await run()).repaired).toBe(0);
    expect([row('dreamer'), row('pm')]).toEqual(first);
    expect(cards()).toEqual([]);
  });

  it('a tool the owner denied in either place is not added, and an unrestricted list is left alone', async () => {
    addAgent('dreamer', 'Curator', OLD_DREAMER, [], ['lesson_record']);
    addAgent('pm', 'Boss', [], []);
    const before = [row('dreamer'), row('pm')];
    expect((await run()).repaired).toBe(0);
    expect([row('dreamer'), row('pm')]).toEqual(before);
  });

  it('an old PM gets only the new tool; the older ones are offered once on a card and to the main agent', async () => {
    addAgent('pm', 'Boss', ANCIENT_PM);
    expect(await run()).toMatchObject({ examined: 1, repaired: 1, flagged: 1 });
    expect(JSON.parse(row('pm').tools_policy).allow).toEqual([...ANCIENT_PM, 'tool_result_read']);
    const [card] = cards();
    expect(card.words).toContain("Boss doesn't have some tools a new Boss gets");
    expect(card.words).toContain('work_validate');
    expect(card.words).not.toContain('tracker_get');
    expect(notices).toHaveLength(1);
    expect(notices[0].toAgentId).toBe('primary');
    expect(notices[0].brief).toContain(card.words);
    dismissOwnerNotice(card.cardKey);
    await run();
    expect(cards()).toEqual([]);
    expect(notices).toHaveLength(1);
  });

  it('a terminated agent is left alone', async () => {
    addAgent('pm', 'Boss', ANCIENT_PM);
    mockDb.current!.prepare("UPDATE agents SET status = 'terminated' WHERE id = 'pm'").run();
    const before = row('pm');
    expect(await run()).toMatchObject({ examined: 0, repaired: 0, flagged: 0 });
    expect(row('pm')).toEqual(before);
    expect(notices).toEqual([]);
  });
});
