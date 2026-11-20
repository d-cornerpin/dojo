// What the storm law counts: the people due an answer now, one per conversation, read through the one waiting
// reader. A request waiting for its own due time is not counted, and an unreadable read stands self-wakes down.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-what-is-counted-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { getWaitingHumanConversations } from '../v2/counterparty.js';
import { selfWakeStandDown } from '../../work/work-reaper.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;

/** A real person's message, as every channel producer hands it to the single writer. */
const ownerInbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: AGENT, role: 'user', content: 'can you check the roof quote?',
  lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
  conversationId: 'conv-1',
  inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  ...over,
});

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, '${FX.n4}', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-1', ?, 'dashboard', 'owner'), ('conv-2', ?, 'imessage', '+15550000')`,
  ).run(AGENT, AGENT);
});

describe('the storm law counts the people due an answer now', () => {
  it('nobody waiting: self-wakes may run', () => {
    expect(selfWakeStandDown(AGENT)).toEqual({ standDown: false, humanAsksOpen: 0 });
  });

  it('three messages in one conversation are one person waiting', () => {
    for (const id of ['m-1', 'm-2', 'm-3']) insertMessage(ownerInbound({ id }) as never);
    expect(selfWakeStandDown(AGENT)).toEqual({ standDown: true, humanAsksOpen: 1 });
    expect(getWaitingHumanConversations(AGENT).length).toBe(1);
  });

  it('two conversations are two people waiting', () => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    insertMessage(ownerInbound({
      id: 'm-2', conversationId: 'conv-2', channel: 'imessage', senderId: '+15550000',
      inboundMeta: JSON.stringify({ channel: 'imessage', relation: 'owner' }),
    }) as never);
    expect(selfWakeStandDown(AGENT).humanAsksOpen).toBe(2);
  });

  it('a request waiting for its own due time (a provider limit) is not counted', () => {
    insertMessage(ownerInbound({ id: 'm-1' }) as never);
    mockDb.current!.prepare("UPDATE work SET next_attempt_at = ? WHERE kind = 'ask'").run(Date.now() + 60_000);
    expect(selfWakeStandDown(AGENT)).toEqual({ standDown: false, humanAsksOpen: 0 });
  });

  it('an unreadable read stands self-wakes down', () => {
    mockDb.current!.exec('DROP TABLE work');
    expect(selfWakeStandDown(AGENT)).toEqual({ standDown: true, humanAsksOpen: -1 });
  });
});
