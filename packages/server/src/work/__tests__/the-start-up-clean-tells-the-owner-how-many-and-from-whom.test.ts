// When the Dojo starts and drops old unanswered messages, the owner gets one card saying how many and from whom.
// A start that drops nothing makes no card.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { askIdForMessage } from '../store.js';
import { sweepBootStaleness } from '../work-reaper.js';
import { insertMessage } from '../../memory/message-store.js';
import { servedOwnerNotices } from '../../healer/owner-notice-kinds.js';

const AGENT = randomUUID();
const db = (): Database.Database => mockDb.current!;
const bootCards = (): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM healer_state WHERE scope = 'owner_told' AND key LIKE 'bootdropped:%'").get() as { n: number }).n;

/** `count` messages from `phone`, each an hour old and unanswered. */
function oldMessagesFrom(phone: string, count: number): void {
  db().prepare("INSERT OR IGNORE INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'imessage', ?)").run(`conv-${phone}`, AGENT, phone);
  for (let i = 0; i < count; i++) {
    const id = `m-${phone}-${i}`;
    insertMessage({
      id, agentId: AGENT, role: 'user', content: `Question ${i}`, lane: 'owner', channel: 'imessage', senderId: phone,
      authorized: true, conversationId: `conv-${phone}`,
      inboundMeta: JSON.stringify({ channel: 'imessage', relation: 'known_contact', sender: phone, authorized: true }),
    } as never);
    db().prepare('UPDATE work SET opened_at = ? WHERE id = ?').run(Date.now() - 3_600_000, askIdForMessage(id));
  }
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Agent', 'idle', '1970-01-01')").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the start-up clean tells the owner how many and from whom', () => {
  it('seven dropped from two senders make one card with each count, shown once', () => {
    oldMessagesFrom('+15550111', 3);
    oldMessagesFrom('+15550100', 4);
    sweepBootStaleness();
    expect(servedOwnerNotices().map((c) => c.words)).toEqual([
      'When the Dojo started it dropped 7 old unanswered messages (more than 30 minutes old): '
        + '4 from +15550100, 3 from +15550111. Nothing was sent to anyone about them.',
    ]);
    expect(servedOwnerNotices()).toEqual([]);
  });

  it('a start that drops nothing makes no card', () => {
    oldMessagesFrom('+15550100', 7);
    sweepBootStaleness();
    sweepBootStaleness();
    expect(bootCards()).toBe(1);
    oldMessagesFrom('+15550111', 2);
    sweepBootStaleness();
    expect(bootCards()).toBe(1);
  });
});
