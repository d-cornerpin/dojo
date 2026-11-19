// With two requests owed, Stop ends only the one being served; the other is answered next. Between turns it ends
// the latest turn's request while that is still started, and never one no turn has started.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { stopByOwner } from '../runtime.js';
import { stoppedAgents } from '../shared-state.js';
import { nextOwed } from '../v2/owed.js';
import { freshAgentsDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); stoppedAgents.clear(); });

describe('stop with two requests ends only the one being served', () => {
  it('the second request stays owed and is served next', async () => {
    const first = await ownerAsks('m-1', 'Rename the archive files');
    await stretch('stopped', async () => {
      await ownerAsks('m-2', 'And what is on my calendar today?');
      expect(stopByOwner(HELPER)).toMatchObject({ ended: 1 });
    });
    expect(rowOf(first).state).toBe('abandoned');
    expect(rowOf('ask:m-2').state).toBe('open');
    expect(nextOwed(HELPER)[0]).toMatchObject({ kind: 'person', ref: 'ask:m-2' });
  });

  it('between turns, a request no turn has started is not touched and Stop says nothing was running', async () => {
    await ownerAsks('m-1');
    expect(stopByOwner(HELPER)).toEqual({ ended: 0, repliesNotSent: 0, nothingRunning: true });
    expect(rowOf('ask:m-1').state).toBe('open');
    expect(stoppedAgents.has(HELPER), 'an idle Stop leaves no flag to cut the next message').toBe(false);
  });
});
