// R7 priority one + OWNER ANSWER 2: where the agent CAN act (an image that failed, a file that did not reach the
// person), the failure is handed to the agent AND the agent is woken so it tells the person now, in its own words.
// The engine writes no text to the person. A wake that is only a rider (never a turn) would leave the person waiting.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('no db'); return mockDb.current; },
  closeDb: vi.fn(),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
const handleMessage = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage }) }));

import { runMigrations } from '../../db/migrations.js';
import { tellAgentAndWake } from '../wake-with-notice.js';
import { getPendingEngineEvent } from '../v2/counterparty.js';

beforeEach(() => {
  const d = new Database(':memory:'); d.pragma('foreign_keys = ON'); mockDb.current = d; runMigrations();
  d.prepare(`INSERT INTO agents (id, name, status, created_at, updated_at) VALUES ('a1', 'Prime', 'idle', datetime('now'), datetime('now'))`).run();
  handleMessage.mockClear();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('tellAgentAndWake', () => {
  it('starts a turn for the agent, with the notice as the pending event it will see', async () => {
    await tellAgentAndWake({ agentId: 'a1', from: 'Image generation', brief: 'the image could not be generated. Tell them.' });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect((handleMessage.mock.calls[0] as unknown as [string])[0]).toBe('a1');
    const ev = getPendingEngineEvent('a1');
    expect(ev, 'the notice is a deliverable event, not a rider').not.toBeNull();
    expect(ev!.content).toContain('the image could not be generated');
  });
});
