// At work_update(action="status") the owner's quote reaches the takeover rule only for the main agent: a helper
// that created a task a live peer now holds cannot reopen it with the owner's words; the main agent can.
// Driven through the tool executor and the real message ingest, in a scratch home.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const PEER = 'agent-peer';
const OWNER_WORDS = 'Please reopen the invoice task.';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'status-quote-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../db/connection.js');
const migrations = await import('../../db/migrations.js');
const platform = await import('../../config/platform.js');
const { executeTool, toolResultOf } = await import('../../agent/tools/index.js');
const { insertMessage } = await import('../../memory/message-store.js');
const { openTurnContext, endTurnContext } = await import('../../agent/turn-context.js');

let n = 0;
beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, ?, ?, '{}', ?)");
  add.run(MAIN, 'main', 'idle', 'sensei');
  add.run(HELPER, 'helper', 'idle', 'apprentice');
  add.run(PEER, 'peer', 'working', 'apprentice');
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});
afterEach(() => { endTurnContext(MAIN); endTurnContext(HELPER); });
afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A failed task the helper created and the live peer holds. */
function peersFinishedTask(): string {
  const id = `task-${++n}-0000-0000`;
  const now = Date.now();
  connection.getDb().prepare(
    `INSERT INTO work (id, kind, agent_id, assignee_agent, requester, requester_id, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, opened_at, updated_at, closed_at)
     VALUES (?, 'task', ?, ?, 'agent', ?, 'tracker', ?, 'failed', 'tracker', 0, 0, 'Reconcile the invoices', ?, ?, ?)`,
  ).run(id, PEER, PEER, HELPER, id, now, now, now);
  return id;
}

/** This turn of `agent` answers the owner's dashboard message. */
function ownerTurn(agent: string): void {
  const id = `msg-${++n}`;
  insertMessage({
    id, agentId: agent, role: 'user', conversationId: `conv-${n}`, channel: 'dashboard', authorized: true, content: OWNER_WORDS,
    inboundMeta: JSON.stringify({ channel: 'dashboard', accountKind: 'agent', authorized: true, relation: 'owner' }),
  });
  openTurnContext(agent).root = { kind: 'ask', id, sourceMessageId: id, conversationId: `conv-${n}` };
}

const reopen = async (agentId: string, taskId: string) => toolResultOf(await executeTool(agentId, {
  id: `call-${++n}`, name: 'work_update', arguments: { action: 'status', task_id: taskId, status: 'in_progress', user_quote: OWNER_WORDS },
})).content;
const stateOf = (id: string) => (connection.getDb().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

describe('a quote at the status door counts only for the main agent', () => {
  it('a helper that created the task cannot reopen it with the owner\'s words', async () => {
    const id = peersFinishedTask();
    ownerTurn(HELPER);
    expect(await reopen(HELPER, id)).toMatch(/^Refused: .*a live agent, and only .* may have another agent reopen it/);
    expect(stateOf(id)).toBe('failed');
  });

  it('the main agent reopens it with the owner\'s words', async () => {
    const id = peersFinishedTask();
    ownerTurn(MAIN);
    expect(await reopen(MAIN, id)).toMatch(/^\[OK\]/);
    expect(stateOf(id)).not.toBe('failed');
  });
});
