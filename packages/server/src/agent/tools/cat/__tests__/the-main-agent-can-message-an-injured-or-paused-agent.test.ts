// The main agent reaches an injured or paused agent the way the Healer does; other senders are
// refused, and the refusal names who can help.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
}));

const deliverSpy = vi.fn();
vi.mock('../../../a2a-transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../a2a-transport.js')>()),
  deliverA2AMessage: (...a: unknown[]) => deliverSpy(...(a as [])),
  isNoWakeIntent: () => false,
}));
vi.mock('../../../../gateway/ws.js', () => ({
  broadcast: () => undefined,
  stampPersistedRow: (e: unknown) => e,
}));

import { agentsHandlers } from '../agents.js';
import { runMigrations } from '../../../../db/migrations.js';
import { clearPlatformConfigCache } from '../../../../config/platform.js';

async function send(from: string): Promise<{ content: string; isError?: boolean }> {
  const h = agentsHandlers['send_to_agent'];
  return h({ agentId: from, args: { agent: 'agent-target', intent: 'ASSIGN', payload: 'A note.' } } as unknown as Parameters<typeof h>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  const add = db.prepare(`INSERT INTO agents (id, name, status, created_at, session_started_at) VALUES (?, ?, ?, '2026-01-02 00:00:00', '1970-01-01')`);
  add.run('agent-main', 'main', 'idle');
  add.run('agent-target', 'target', 'paused');
  add.run('agent-helper', 'helper', 'idle');
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', 'agent-main')").run();
  clearPlatformConfigCache();
  deliverSpy.mockResolvedValue({ delivered: true, threadId: 't-1', messageId: 'm-1' });
});

describe('the main agent can message an injured or paused agent', () => {
  it("the main agent's message to a paused agent is delivered", async () => {
    const r = await send('agent-main');
    expect(r.isError).toBeFalsy();
    expect(deliverSpy).toHaveBeenCalledTimes(1);
  });

  it('a helper is refused and told who can help', async () => {
    const r = await send('agent-helper');
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Message NOT delivered');
    expect(r.content).toContain('tell the main agent');
    expect(deliverSpy).not.toHaveBeenCalled();
  });
});
