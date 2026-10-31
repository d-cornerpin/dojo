// 983: naming yourself as the recipient of send_to_agent is refused, not delivered to your own inbox.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-983-self-send', 'dojo.db'),
  };
});

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
import { FX, FXID } from '../../../../../../../deploy/checks/fixture-vocabulary.mjs';

const ME = FXID.n4;
const OTHER = FXID.n5;

async function send(agent: string): Promise<{ content: string; isError?: boolean }> {
  const h = agentsHandlers['send_to_agent'];
  return h({ agentId: ME, args: { agent, intent: 'ASSIGN', payload: 'A note.' } } as unknown as Parameters<typeof h>[0]);
}

const ownInbound = (): number =>
  (mockDb.current!.prepare('SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND source_agent_id = ?').get(ME, ME) as { n: number }).n;

beforeEach(() => {
  vi.clearAllMocks();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  for (const [id, name] of [[ME, FX.n4], [OTHER, FX.n5]] as const) {
    db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, ?, 'idle', '1970-01-01')`).run(id, name);
  }
  deliverSpy.mockResolvedValue({ delivered: true, threadId: 't-1', messageId: 'm-1' });
});

describe('983 — send_to_agent refuses the sender as the recipient', () => {
  it('by id', async () => {
    const r = await send(ME);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('is you');
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(ownInbound()).toBe(0);
  });

  it('by name', async () => {
    const r = await send(FX.n4);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('is you');
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(ownInbound()).toBe(0);
  });

  it('another agent is still delivered', async () => {
    const r = await send(OTHER);
    expect(r.isError).toBeFalsy();
    expect(deliverSpy).toHaveBeenCalledTimes(1);
  });
});
