// A task given to a group is held by one of its members, whether it is opened for the group or moved to it,
// and a group with nobody free is refused instead of leaving the task with whoever asked.
// Driven through the tool executor in a scratch home.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => 'ran', whenQueuedRunEnds: async () => 'ran' }),
}));

const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'group-task-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../db/connection.js');
const migrations = await import('../../db/migrations.js');
const platform = await import('../../config/platform.js');
const { executeTool, toolResultOf } = await import('../../agent/tools/index.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  db.prepare("INSERT INTO agent_groups (id, name, created_by) VALUES ('grp-writers', 'Writers', ?), ('grp-empty', 'Empty', ?)").run(MAIN, MAIN);
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, group_id) VALUES (?, ?, ?, '{}', ?, ?)");
  add.run(MAIN, 'main', 'idle', 'sensei', null);
  add.run('agent-busy', 'busy', 'working', 'apprentice', 'grp-writers');
  add.run('agent-free', 'free', 'idle', 'apprentice', 'grp-writers');
  add.run('agent-gone', 'gone', 'terminated', 'apprentice', 'grp-empty');
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});
afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

let n = 0;
const call = async (args: Record<string, unknown>, name = 'work_open') =>
  toolResultOf(await executeTool(MAIN, { id: `call-${++n}`, name, arguments: args }));
const holderOf = (title: string) => (connection.getDb().prepare(
  "SELECT agent_id, assignee_agent FROM work WHERE kind = 'task' AND title = ?",
).get(title) as { agent_id: string; assignee_agent: string | null });

describe('a task given to a group is held by a member', () => {
  it('opening a task for a group gives it to the free member, not to the agent that asked', async () => {
    const res = await call({ kind: 'task', title: 'Draft the newsletter', goal: 'a newsletter draft is ready', assigned_to_group: 'grp-writers' });
    expect(res.isError, res.content).toBeFalsy();
    expect(holderOf('Draft the newsletter')).toEqual({ agent_id: 'agent-free', assignee_agent: 'agent-free' });
  });

  it('moving a task to a group gives it to a member', async () => {
    await call({ kind: 'task', title: 'Proofread the post', goal: 'the post is proofread' });
    const id = (connection.getDb().prepare("SELECT id FROM work WHERE title = 'Proofread the post'").get() as { id: string }).id;
    const res = await call({ action: 'reassign', task_id: id, assigned_to_group: 'grp-writers', cause: 'coordination' }, 'work_update');
    expect(res.isError, res.content).toBeFalsy();
    expect(holderOf('Proofread the post').agent_id).toBe('agent-free');
  });

  it('a group with nobody free is refused and opens nothing', async () => {
    const res = await call({ kind: 'task', title: 'Nobody can take this', goal: 'it is done', assigned_to_group: 'grp-empty' });
    expect(res.isError).toBe(true);
    expect(holderOf('Nobody can take this')).toBeUndefined();
  });
});
