// A helper's question or progress note on its job's thread reaches the agent that gave the job and the job stays
// open; only an answer lands, and it lands whole. The agent's open work names the helper it waits on.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { transition } from '../../work/store.js';
import { buildOpenWorkInjection } from '../../work/obligations.js';
import { freshAgentsDb, testDb, askerDelegates, pieceState, ASKER, HELPER } from './helpers/agent-requests.js';

const THREAD = 'thread-job-one';
const helperSays = (intent: 'QUESTION' | 'STATUS' | 'ANSWER', payload: string) => deliverA2AMessage({
  intent, threadId: THREAD, requiresResponse: intent !== 'STATUS', payload, toAgent: ASKER, fromAgent: HELPER,
});
const pieceNotes = (ask: string): string | null =>
  (testDb().prepare('SELECT notes FROM work WHERE parent_id = ?').get(ask) as { notes: string | null }).notes;

beforeEach(() => { freshAgentsDb(runMigrations); });

describe("a helper's question goes to the agent that gave the job, and the job stays open", () => {
  it('a question and a progress note reach the agent and land nothing', async () => {
    const ask = await askerDelegates('ASSIGN', THREAD);
    expect((await helperSays('QUESTION', 'Which year do you want the figure for?')).delivered).toBe(true);
    expect((await helperSays('STATUS', 'Halfway through the archive now.')).delivered).toBe(true);
    expect(pieceState(ask)).toBe('open');
    expect(testDb().prepare('SELECT a2a_intent AS i FROM messages WHERE agent_id = ? AND source_agent_id = ? ORDER BY seq')
      .all(ASKER, HELPER)).toEqual([{ i: 'QUESTION' }, { i: 'STATUS' }]);
  });

  it("the agent's open work names the helper and the thread it waits on", async () => {
    const ask = await askerDelegates('ASSIGN', THREAD);
    transition(ask, { to: 'blocked', by: 'agent', actorId: ASKER, reason: 'held on the delegation' });
    expect(buildOpenWorkInjection(ASKER, null)).toContain('waiting on Helper (thread job-one)');
  });

  it('an answer lands, and a long one is kept whole', async () => {
    const ask = await askerDelegates('ASSIGN', THREAD);
    const long = `The figure is 4,210. ${'This is how it was found in the archive. '.repeat(120)}`.trim();
    await helperSays('ANSWER', long);
    expect(pieceState(ask)).toBe('done');
    expect(pieceNotes(ask)).toBe(long);
  });
});
