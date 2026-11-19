import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getPrimaryAgentId: () => 'main' }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { archiveAgentConversation } from '../archive.js';
import { discardConversation, bulkDiscardUnprocessedConversations } from '../store.js';

const AGENT = 'agent-discard';
const say = (content: string): void => { insertMessage({ agentId: AGENT, role: 'user', content } as never); };
const countOf = (archiveId: string | null): number =>
  (mockDb.current!.prepare('SELECT message_count AS n FROM vault_conversations WHERE id = ?').get(archiveId) as { n: number }).n;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES (?, 'Helper', 'idle', '{}')").run(AGENT);
  say('Plan the garden beds for spring.');
  say('Order seeds for the tomatoes.');
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('discarding an archive does not re-copy history at the next reset', () => {
  it('after the Dreamer discards an archive, the next reset copies only what is new', () => {
    const first = archiveAgentConversation(AGENT, true);
    expect(countOf(first)).toBe(2);
    expect(discardConversation(first!)).toBe(true);
    say('Water the herbs on Friday.');
    const next = archiveAgentConversation(AGENT, true);
    expect(countOf(next)).toBe(1);
  });
  it('the same after the backlog button discards it', () => {
    archiveAgentConversation(AGENT, true);
    expect(bulkDiscardUnprocessedConversations({ agentId: AGENT })).toBe(1);
    say('Water the herbs on Friday.');
    const next = archiveAgentConversation(AGENT, true);
    expect(countOf(next)).toBe(1);
  });
});
