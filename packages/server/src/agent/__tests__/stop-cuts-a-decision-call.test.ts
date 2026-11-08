// A decision an agent waits on is that agent's call: its Stop cuts it, waiting for the call slot or in flight, and the
// rule answers. The decision model is a scripted fetch that never answers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import '../decision-ask.js';
import { decide, type Question } from '../decide.js';
import { abortInFlight } from '../shared-state.js';
import { deliverableJudged } from '../v2/classifiers/inbound-routing.js';
import { installDecisionModel } from './decision-fake.js';

const sent: string[] = [];
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  installDecisionModel(mockDb.current);
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: { body?: string; signal?: AbortSignal }) => new Promise((_r, reject) => {
    sent.push(init?.body ?? '');
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('the agent\'s Stop', () => {
  it('cuts a decision in flight, and the rule answers', async () => {
    const asked = deliverableJudged('agent-stop-1', 'Here is the finished report.', true);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    abortInFlight('agent-stop-1', 'user_stop');
    expect(await asked).toBe(true);
  });

  it('cuts a decision still waiting for the call slot, and it is never sent', async () => {
    const Q: Record<string, Question> = { q: { type: 'noul', instructions: 'q?' } };
    const ahead = decide({ x: 'ahead' }, Q, { purpose: 'probe', agentId: 'agent-ahead' });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const waiting = deliverableJudged('agent-stop-2', 'Here is the finished report.', true);
    abortInFlight('agent-stop-2', 'user_stop');
    expect(await waiting).toBe(true);
    abortInFlight('agent-ahead', 'user_stop');
    expect(await ahead).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
  });
});
