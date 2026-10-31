// A request id from the OPEN WORK block (`ask:` or `piece:ask:`) handed to
// work_close_request used to land on the override verb and answer "Task not found",
// which says nothing about what the id is or how that work ends. It now says so.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../tracker/pm-agent.js', () => ({
  ensurePMAgentRunning: () => { /* no-op */ },
  noteTransitionForReview: () => { /* no-op */ },
}));
vi.mock('../../tracker/notify.js', () => ({
  injectTaskAssignmentNotification: () => { /* no-op */ },
  claimAssignmentNoticeForTerminalTask: () => false,
}));

import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { createWorkTable } from '../../work/__tests__/work-fixture.js';

const AGENT = 'worker-agent-0001';
const JUSTIFICATION = 'The engine refused this close but the evidence on file shows the work finished.';

beforeEach(() => {
  const db = new Database(':memory:');
  createWorkTable(db);
  mockDb.current = db;
});

const close = (id: string) =>
  trackerHandlers['work_close_request:override']!({
    agentId: AGENT,
    args: { task_id: id, requested_status: 'completed', justification: JUSTIFICATION },
  } as never);

describe('work_close_request with an ask id', () => {
  for (const id of ['ask:11112222-3333-4444-5555-666677778888', 'piece:ask:11112222-3333-4444-5555-666677778888:99990000-aaaa-bbbb-cccc-ddddeeeeffff']) {
    it(`says what ${id.slice(0, 9)}... is and how it ends`, async () => {
      const r = await close(id);
      expect(r.content).toMatch(/request from the owner|piece of one/i);
      expect(r.content).toMatch(/reply|answer/i);
      expect(r.content).not.toMatch(/not found/i);
    });
  }

  it('leaves an ordinary unknown id with the usual not-found answer', async () => {
    const r = await close('no-such-task-1234');
    expect(r.content).toMatch(/not found/i);
  });
});
