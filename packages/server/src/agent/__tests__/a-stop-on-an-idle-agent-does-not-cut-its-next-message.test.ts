// A Stop pressed while the agent ran nothing does not cut the next message it gets: the run that message
// starts is not stopped. A stop whose run is still winding down keeps holding. Through the real handleMessage.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-idle-stop', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const seen = vi.hoisted(() => ({ stoppedAtStart: [] as boolean[] }));
vi.mock('../v2/loop.js', async () => {
  const { isStopFenced } = await import('../shared-state.js');
  return { runV2Turn: vi.fn(async (id: string) => { seen.stoppedAtStart.push(isStopFenced(id)); }) };
});

import { runMigrations } from '../../db/migrations.js';
import { getAgentRuntime, stopAgent } from '../runtime.js';
import { activeRuns, stoppedAgents, stopFencedRuns, isStopFenced } from '../shared-state.js';

const AGENT = randomUUID();

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'Agent', 'idle', 'sensei')").run(AGENT);
  seen.stoppedAtStart.length = 0;
});
afterEach(() => {
  stoppedAgents.delete(AGENT); stopFencedRuns.delete(AGENT); activeRuns.delete(AGENT);
  mockDb.current?.close(); mockDb.current = null;
});

describe('a stop on an idle agent does not cut its next message', () => {
  it('Stop with nothing running, then a message: the run it starts is not stopped and completes', async () => {
    stopAgent(AGENT);
    expect(isStopFenced(AGENT)).toBe(true);
    expect(await getAgentRuntime().handleMessage(AGENT, '')).toBe('ran');
    expect(seen.stoppedAtStart).toEqual([false]);
  });

  it('a stop whose run is still winding down (its fence is up) still holds the next run', async () => {
    stoppedAgents.add(AGENT);
    stopFencedRuns.set(AGENT, Date.now());
    expect(await getAgentRuntime().handleMessage(AGENT, '')).toBe('ran');
    expect(seen.stoppedAtStart).toEqual([true]);
  });
});
