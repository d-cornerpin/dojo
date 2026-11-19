// On update day each agent still owes exactly the one request the old reply table owed (its newest
// reply-needed request, when that one had no reply row); the other requests of the last day are given up.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runMigrations, migrationFileNames } from '../migrations.js';
import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';

const STEP = migrationFileNames().find((f) => f.includes('agent_requests_from_records'))!;
const HOUR = 60 * 60_000;
const tableExists = (): boolean =>
  doneDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'a2a_replies'").get() !== undefined;

/** One row in `agentId`'s store, `agoMs` old; returns its id. */
function row(agentId: string, agoMs: number, intent: string, lane = 'a2a'): string {
  const id = randomUUID();
  doneDb().prepare(`INSERT INTO messages (id, agent_id, role, lane, content, a2a_intent, a2a_thread_id, source_agent_id, created_at)
    VALUES (?, ?, 'user', ?, 'the figure, please', ?, ?, 'the-asker', ?)`).run(id, agentId, lane, intent, `thread-${id}`, Date.now() - agoMs);
  return id;
}
const swept = (id: string): boolean =>
  (doneDb().prepare('SELECT swept_at FROM messages WHERE id = ?').get(id) as { swept_at: number | null }).swept_at !== null;

/** A box from before the update: the reply table holds `replied`; then the step runs. */
function update(replied: string[]): void {
  doneDb().exec(`CREATE TABLE a2a_replies (assign_message_id TEXT NOT NULL PRIMARY KEY, agent_id TEXT NOT NULL,
    thread_id TEXT NOT NULL, reply_intent TEXT NOT NULL, replied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  for (const m of replied) doneDb().prepare("INSERT INTO a2a_replies VALUES (?, 'helper', 't', 'ANSWER', datetime('now'))").run(m);
  doneDb().prepare('DELETE FROM _migrations WHERE name = ?').run(STEP);
  runMigrations();
}

let helper = '';
beforeEach(() => {
  freshDoneDb();
  runMigrations();
  helper = randomUUID();
  doneDb().prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Helper', 'idle')").run(helper);
});

describe('upgrade day leaves one owed request per agent, as before', () => {
  it('a fresh box has no reply table', () => {
    expect(tableExists()).toBe(false);
  });

  it('the newest unreplied request stays owed; the older ones of the last day are given up', () => {
    const older = row(helper, 3 * HOUR, 'QUESTION');
    const newest = row(helper, HOUR, 'ASSIGN');
    update([]);
    expect([swept(older), swept(newest)]).toEqual([true, false]);
    expect(tableExists()).toBe(false);
  });

  it('when the newest request was replied, none stays owed', () => {
    const older = row(helper, 3 * HOUR, 'QUESTION');
    const newest = row(helper, HOUR, 'BLOCK');
    update([newest]);
    expect([swept(older), swept(newest)]).toEqual([true, true]);
  });

  it('a request older than a day, an engine notice and a reply are left as they were', () => {
    const old = row(helper, 30 * HOUR, 'QUESTION');
    const notice = row(helper, 2 * HOUR, 'QUESTION', 'events');
    const answer = row(helper, 2 * HOUR, 'ANSWER');
    row(helper, HOUR, 'QUESTION');
    update([]);
    expect([swept(old), swept(notice), swept(answer)]).toEqual([false, false, false]);
  });
});
