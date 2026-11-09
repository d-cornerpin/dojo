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

const turnCtx = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../turn-context.js', () => ({ turnContext: () => turnCtx.current }));

import { runMigrations } from '../../db/migrations.js';
import { tellAgentAndWake } from '../wake-with-notice.js';
import { getPendingEngineEvent } from '../v2/counterparty.js';

beforeEach(() => {
  const d = new Database(':memory:'); d.pragma('foreign_keys = ON'); mockDb.current = d; runMigrations();
  d.prepare(`INSERT INTO agents (id, name, status, created_at, updated_at) VALUES ('a1', 'Prime', 'idle', datetime('now'), datetime('now'))`).run();
  handleMessage.mockClear();
  turnCtx.current = undefined;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('no wake loop: a failure INSIDE a turn woken by a failure notice does not wake again', () => {
  it('the second failure is told as a rider (seen on the agent\'s next turn) and starts no turn', async () => {
    await tellAgentAndWake({ agentId: 'a1', from: 'Image generation', brief: 'first failure' });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const first = mockDb.current!.prepare(`SELECT id FROM messages WHERE agent_id = 'a1' AND origin_intent = 'delivery_failure_owed'`).get() as { id: string };
    turnCtx.current = { triggerMessageId: first.id };   // the engine is now running the turn that notice woke
    await tellAgentAndWake({ agentId: 'a1', from: 'Image generation', brief: 'second failure, same request' });
    expect(handleMessage, 'no second wake: the agent is already on it').toHaveBeenCalledTimes(1);
    const rows = mockDb.current!.prepare(`SELECT content, origin_intent FROM messages WHERE agent_id = 'a1' AND lane = 'events' ORDER BY rowid`).all() as Array<{ content: string; origin_intent: string }>;
    expect(rows.some((r) => r.content.includes('second failure') && r.origin_intent !== 'delivery_failure_owed')).toBe(true);
  });
  it('a failure on an ordinary person-triggered turn still wakes', async () => {
    turnCtx.current = { triggerMessageId: 'some-user-message' };
    await tellAgentAndWake({ agentId: 'a1', from: 'Image generation', brief: 'x' });
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});

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
