// After an update the Dreamer and the PM get every tool their build lists, in the column and the
// grants, except a name the owner denied or took out in an audited edit; an unrestricted list and a
// terminated agent are left alone, and no owner notice is raised. Driven through the real release
// step on the real migration chain; the owner's edit goes through the real PUT /api/agents/:id.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { RELEASE_STEPS } from '../release-steps.js';
import { forgetAccessGrants, getAccessGrants } from '../../agent/access/read.js';
import { agentsRouter } from '../../gateway/routes/agents.js';
import { DREAMER_TOOLS_POLICY } from '../../vault/maintenance.js';
import { PM_ALLOWED_TOOLS } from '../../tracker/pm-agent.js';
import { standingOwnerNotices } from '../../healer/owner-notice-kinds.js';

const DREAMER = JSON.parse(DREAMER_TOOLS_POLICY).allow as string[];
const PM = [...PM_ALLOWED_TOOLS];
// What a PM written before the verb collapse held (old alias names on purpose).
const ANCIENT_PM = ['tracker_list_projects', 'tracker_get', 'send_to_agent', 'list_agents', 'vault_search', 'get_current_time'];
const grantsOf = (tools: object) => ({ grants: { v: 1, tools: { categories: '*', ...tools }, integrations: { plaud: true, credentials: true, google: { agent: 'none', user: 'none' }, microsoft: { agent: 'none', user: 'none' } }, channels: { master: null, imessage: 'none', sms: 'none', voice: 'none', email: 'none', teams: 'none' }, techniques: '*' } });

const step = RELEASE_STEPS.find((s) => s.id === 'built-in-tools')!;
const run = () => step.run() as Promise<{ examined: number; flagged: number; repaired: number }>;
function addAgent(id: string, allow: string[], deny: string[] = []) {
  mockDb.current!.prepare(`INSERT INTO agents (id, name, status, classification, tools_policy, permissions) VALUES (?, ?, 'idle', 'sensei', ?, ?)`)
    .run(id, id, JSON.stringify({ allow, deny }), JSON.stringify({ file_read: ['x'], ...grantsOf({ allow, deny }) }));
  forgetAccessGrants();
}
const row = (id: string) => mockDb.current!.prepare('SELECT tools_policy, permissions FROM agents WHERE id = ?').get(id) as { tools_policy: string; permissions: string };
const allowOf = (id: string): string[] => JSON.parse(row(id).tools_policy).allow;
const put = (id: string, body: unknown): Promise<Response> =>
  agentsRouter.request(`/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); forgetAccessGrants(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('an upgraded built-in agent gets every tool its build lists', () => {
  it('an old PM gets every missing name in the column and the grants; a second pass changes nothing', async () => {
    addAgent('pm', ANCIENT_PM);
    expect(await run()).toMatchObject({ examined: 1, repaired: 1, flagged: 0 });
    for (const t of PM) expect(getAccessGrants('pm').tools.allow).toContain(t);
    expect(allowOf('pm')).toEqual(expect.arrayContaining(PM));
    expect(JSON.parse(row('pm').permissions).file_read).toEqual(['x']);
    const first = row('pm');
    expect((await run()).repaired).toBe(0);
    expect(row('pm')).toEqual(first);
    expect(standingOwnerNotices()).toEqual([]);
  });

  it('a name the owner took out through the dashboard is not put back', async () => {
    const trimmed = 'list_agents';
    expect(PM).toContain(trimmed);
    const old = PM.filter((t) => t !== 'tool_result_read');
    addAgent('pm', old);
    const res = await put('pm', { toolsPolicy: { allow: old.filter((t) => t !== trimmed), deny: [] } });
    expect(res.status).toBe(200);
    expect(await run()).toMatchObject({ repaired: 1 });
    expect(getAccessGrants('pm').tools.allow).toContain('tool_result_read');
    expect(getAccessGrants('pm').tools.allow).not.toContain(trimmed);
    expect(allowOf('pm')).not.toContain(trimmed);
  });

  it('a denied name and an unrestricted list are left alone, and so is a terminated agent', async () => {
    addAgent('dreamer', DREAMER.filter((t) => t !== 'lesson_record'), ['lesson_record']);
    addAgent('pm', []);
    const before = [row('dreamer'), row('pm')];
    expect((await run()).repaired).toBe(0);
    expect([row('dreamer'), row('pm')]).toEqual(before);
    mockDb.current!.prepare("UPDATE agents SET status = 'terminated', tools_policy = ? WHERE id = 'pm'").run(JSON.stringify({ allow: ANCIENT_PM, deny: [] }));
    expect(await run()).toMatchObject({ examined: 1, repaired: 0 });
  });
});
