import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => undefined }) }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => undefined }));
vi.mock('../../tracker/pm-agent.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensurePMAgentRunning: () => undefined,
}));
import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { askIdForMessage } from '../store.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';

const AGENT = randomUUID();
const drop = (id: string, note: string): Promise<{ content: string; isError?: boolean }> =>
  trackerHandlers['work_close_request:commitment']({
    agentId: AGENT, args: { id, disposition: 'dropped', note }, toolCallId: 'tc-1', turnNumber: 1,
  } as never) as Promise<{ content: string; isError?: boolean }>;
const ownerSays = (content: string): string => {
  const id = randomUUID();
  insertMessage({
    id, agentId: AGENT, role: 'user', content, lane: 'owner', channel: 'dashboard', senderId: 'owner',
    authorized: true, inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as never);
  return askIdForMessage(id);
};
const state = (id: string): string =>
  (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Main', 'idle', '1970-01-01')").run(AGENT);
});

describe('an agent cannot drop a request without the asker\'s words', () => {
  it('a note nobody wrote is refused and the request stays open', async () => {
    const askId = ownerSays('Compare three budget earbuds for flights');
    const res = await drop(askId, 'The user called it off');
    expect(res.isError).toBe(true);
    expect(res.content).toBe('Not dropped: quote what they said when they called it off, word for word, as the note.');
    expect(state(askId)).toBe('open');
  });

  it('the owner\'s own sentence drops it', async () => {
    const askId = ownerSays('Compare three budget earbuds for flights');
    ownerSays('Never mind, forget the earbuds.');
    const res = await drop(askId, 'Never mind, forget the earbuds');
    expect(res.isError).toBeFalsy();
    expect(state(askId)).toBe('abandoned');
  });
});
