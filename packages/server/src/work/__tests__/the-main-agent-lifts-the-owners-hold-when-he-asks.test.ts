// A hold the owner set is lifted by the owner, or by the main agent citing the owner's own words from
// the message this turn answers. Without a confirmed quote, and for every other agent, it stands.
// Driven through the tool executor and the dashboard route with the real schema in a scratch home.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const OWNER_WORDS = 'Go ahead and pick the invoice task back up now';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'owner-hold-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../db/connection.js');
const migrations = await import('../../db/migrations.js');
const platform = await import('../../config/platform.js');
const { executeTool, toolResultOf } = await import('../../agent/tools/index.js');
const { setHold, holdOf } = await import('../done/hold.js');
const { openTurnContext, endTurnContext } = await import('../../agent/turn-context.js');
const { AUDIT_KIND } = await import('../audit-trail.js');
const { trackerRouter } = await import('../../gateway/routes/tracker.js');

let n = 0;
beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, ?, 'idle', '{}', ?)");
  add.run(MAIN, 'main', 'sensei');
  add.run(HELPER, 'helper', 'apprentice');
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});
afterEach(() => { endTurnContext(MAIN); endTurnContext(HELPER); });
afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A Working task held by `holder` that the owner put on hold. */
function ownerHeldTask(holder: string): string {
  const id = `task-${++n}-0000-0000`;
  connection.getDb().prepare(
    `INSERT INTO work (id, kind, agent_id, assignee_agent, requester, requester_id, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, opened_at, updated_at)
     VALUES (?, 'task', ?, ?, 'agent', ?, 'tracker', ?, 'claimed', 'tracker', 0, 0, 'Reconcile the invoices', ?, ?)`,
  ).run(id, holder, holder, holder, id, Date.now(), Date.now());
  expect(setHold(id, 'paused', 'the owner wants to look first', 'owner')).toEqual({ ok: true });
  return id;
}

/** This turn of `agent` answers an owner message saying `words`. */
function ownerTurn(agent: string, words: string): void {
  const msg = `msg-${++n}`;
  const db = connection.getDb();
  db.prepare("INSERT INTO messages (id, agent_id, conversation_id, role, content, channel, inbound_meta, created_at) VALUES (?, ?, 'conv-1', 'user', ?, 'dashboard', ?, ?)")
    .run(msg, agent, words, JSON.stringify({ channel: 'dashboard', accountKind: 'agent', authorized: true, relation: 'owner' }), Date.now());
  db.prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, opened_at, updated_at)
              VALUES (?, 'ask', ?, 'owner', 'ask', ?, 'claimed', 'ask', 1, 0, ?, ?)`).run(`ask-${msg}`, agent, msg, Date.now(), Date.now());
  openTurnContext(agent).root = { kind: 'ask', id: msg, sourceMessageId: msg, conversationId: 'conv-1' };
}

const resume = async (agentId: string, taskId: string, quote?: string) =>
  toolResultOf(await executeTool(agentId, {
    id: `call-${++n}`, name: 'work_update',
    arguments: { action: 'status', task_id: taskId, status: 'in_progress', ...(quote ? { user_quote: quote } : {}) },
  })).content;

const holdClears = (taskId: string) =>
  (connection.getDb().prepare('SELECT actor, payload FROM work_events WHERE work_id = ? AND kind = ? ORDER BY id').all(taskId, AUDIT_KIND) as Array<{ actor: string; payload: string }>)
    .map((e) => ({ actor: e.actor, ...JSON.parse(e.payload) as { entry_kind: string; note: string | null } }))
    .filter((e) => e.entry_kind === 'hold_cleared');

describe('the main agent lifts the owner\'s hold when he asks', () => {
  it('without a quote the main agent is refused and told how', async () => {
    const id = ownerHeldTask(MAIN);
    ownerTurn(MAIN, OWNER_WORDS);
    const content = await resume(MAIN, id);
    expect(content).toMatch(/^Refused: .*on hold/);
    expect(content).toContain('call again with user_quote');
    expect(holdOf(id)?.kind).toBe('paused');
  });

  it('with the owner\'s words from this turn the hold is lifted and the trail records his ask', async () => {
    const id = ownerHeldTask(MAIN);
    ownerTurn(MAIN, OWNER_WORDS);
    const content = await resume(MAIN, id, OWNER_WORDS);
    expect(content).toMatch(/^\[OK\]/);
    expect(holdOf(id)).toBeNull();
    const [entry] = holdClears(id);
    expect(entry.actor).toBe(MAIN);
    expect(entry.note).toContain(OWNER_WORDS);
  });

  it('a quote the owner never said is refused', async () => {
    const id = ownerHeldTask(MAIN);
    ownerTurn(MAIN, OWNER_WORDS);
    expect(await resume(MAIN, id, 'Release every hold you like')).toMatch(/^Refused: /);
    expect(holdOf(id)?.kind).toBe('paused');
  });

  it('a helper is refused even with the owner\'s real words', async () => {
    const id = ownerHeldTask(HELPER);
    ownerTurn(HELPER, OWNER_WORDS);
    expect(await resume(HELPER, id, OWNER_WORDS)).toMatch(/^Refused: /);
    expect(holdOf(id)?.kind).toBe('paused');
  });

  it('the owner still lifts it from the dashboard', async () => {
    const id = ownerHeldTask(MAIN);
    const res = await trackerRouter.request(`/tasks/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'in_progress' }),
    });
    expect(res.status).toBe(200);
    expect(holdOf(id)).toBeNull();
    expect(holdClears(id)[0]?.actor).toBe('owner');
  });
});
