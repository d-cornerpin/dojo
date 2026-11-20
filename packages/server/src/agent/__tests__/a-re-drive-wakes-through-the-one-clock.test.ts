// A re-drive writes its event and leaves the wake to the one clock: the re-drive starts no turn itself, and the
// clock wakes the agent once for that event.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const wake = vi.hoisted(() => vi.fn(async (_agentId: string, _content: string) => 'ran'));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: wake }) }));

import { runMigrations } from '../../db/migrations.js';
import { redriveWithoutReply } from '../agent-notice.js';
import { freshAgentsDb, testDb, HELPER } from './helpers/agent-requests.js';

beforeEach(() => {
  vi.useFakeTimers();
  freshAgentsDb(runMigrations);
  wake.mockClear();
  // The woken turn serves its event.
  wake.mockImplementation(async (id: string) => {
    testDb().prepare("UPDATE messages SET served_by_turn = 1 WHERE agent_id = ? AND lane = 'events'").run(id);
    return 'ran';
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('a re-drive wakes through the one clock', () => {
  it('the re-drive starts no turn; the clock wakes the agent once', async () => {
    expect(await redriveWithoutReply({ toAgentId: HELPER, fromAgentId: null, content: '[Engine hint: still going?]', taskId: null })).toBe(true);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wake.mock.calls).toEqual([[HELPER, '']]);
  });
});
