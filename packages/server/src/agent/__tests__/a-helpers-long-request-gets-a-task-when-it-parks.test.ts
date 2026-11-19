// Another agent's QUESTION opens no task; when the helper's turn on it parks, the park opens the engine task for
// that request on its thread, and the job's next turn is served from that row on the thread, not as a fresh request.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { nextOwed } from '../v2/owed.js';
import { PARKED_JOB_TITLE } from '../../work/job-continuation.js';
import { freshAgentsDb, askerDelegates, testDb, HELPER } from './helpers/agent-requests.js';
import { stretch } from './helpers/long-job.js';

const THREAD = 'thread-helper-long-0001';
beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a helper\'s long request gets a task when it parks', () => {
  it('the park opens one task on the request\'s thread; the next turn is the job\'s own, on that thread', async () => {
    await askerDelegates('QUESTION', THREAD);
    const first = await stretch('parks');
    const task = testDb().prepare('SELECT id, title, a2a_thread_id AS thread, source_message_id AS source FROM work WHERE id = ?').get(first!.parkedOn) as
      { id: string; title: string; thread: string; source: string };
    const request = (testDb().prepare("SELECT id FROM messages WHERE agent_id = ? AND a2a_intent = 'QUESTION'").get(HELPER) as { id: string }).id;
    expect(task).toMatchObject({ title: PARKED_JOB_TITLE, thread: THREAD, source: request });
    expect(nextOwed(HELPER).map((i) => i.kind), 'the request is the job\'s now, not an item of its own').toEqual(['job']);
    expect(await stretch('parks')).toMatchObject({ kind: 'a2a', root: THREAD, servedJob: task.id, parkedOn: task.id });
  });
});
