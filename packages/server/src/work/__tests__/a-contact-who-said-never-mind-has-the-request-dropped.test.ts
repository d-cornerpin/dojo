import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { fenceExternal } from '@dojo/shared';

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
const contactSays = (sender: string, text: string): string => {
  const id = randomUUID();
  insertMessage({
    id, agentId: AGENT, role: 'user', content: fenceExternal('text message', 'a contact', text, { addressedToAgent: true }),
    lane: 'owner', channel: 'imessage', senderId: sender, authorized: true,
    inboundMeta: JSON.stringify({ channel: 'imessage', relation: 'known_contact', sender, authorized: true }),
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

describe('a contact who said never mind has the request dropped', () => {
  it('the contact\'s own words drop their request', async () => {
    const askId = contactSays('+15550100', 'Can you find me a plumber for Tuesday?');
    contactSays('+15550100', 'Never mind, my neighbour fixed it.');
    const res = await drop(askId, 'Never mind, my neighbour fixed it');
    expect(res.isError).toBeFalsy();
    expect(state(askId)).toBe('abandoned');
  });

  it('someone else\'s words do not', async () => {
    const askId = contactSays('+15550100', 'Can you find me a plumber for Tuesday?');
    contactSays('+15550199', 'Never mind, my neighbour fixed it.');
    const res = await drop(askId, 'Never mind, my neighbour fixed it');
    expect(res.isError).toBe(true);
    expect(state(askId)).toBe('open');
  });
});
