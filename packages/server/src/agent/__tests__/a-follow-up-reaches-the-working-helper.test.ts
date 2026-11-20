// A follow-up the agent sends on a job's thread while the helper is still working reaches the helper at once,
// however soon after the first message it goes.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { freshAgentsDb, testDb, askerDelegates, ASKER, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-job-two';
const askerSends = (intent: 'QUESTION' | 'ASSIGN', payload: string) => deliverA2AMessage({
  intent, threadId: THREAD, requiresResponse: true, payload, toAgent: HELPER, fromAgent: ASKER,
});
const helperRows = (): number => (testDb().prepare(
  'SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND source_agent_id = ? AND a2a_thread_id = ?',
).get(HELPER, ASKER, THREAD) as { n: number }).n;

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a follow-up reaches the working helper', () => {
  it('a second message on the job thread a moment after the first is delivered', async () => {
    await askerDelegates('ASSIGN', THREAD);
    const more = await askerSends('QUESTION', 'Also include the prices for each of the three vendors, please.');
    expect(more.delivered).toBe(true);
    expect(helperRows()).toBe(2);
  });

  it('a further assignment on the same thread is delivered too', async () => {
    await askerDelegates('ASSIGN', THREAD);
    const more = await askerSends('ASSIGN', 'When that is done, draft a one-page summary of the comparison.');
    expect(more.delivered).toBe(true);
    expect(helperRows()).toBe(2);
  });
});
