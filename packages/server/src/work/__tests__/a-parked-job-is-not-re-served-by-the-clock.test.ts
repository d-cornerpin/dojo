// A turn the turn budget ended by parking its job hands its request back
// uncounted and with no due, and the one clock leaves it to the job's own continuation; once that continuation has
// run, the request is the clock's again.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { parkJob } from '../job-continuation.js';
import { beginJobRun, endJobRun, endJobCarry, parkedContinuationFor } from '../task-freshness.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { pendingWakeups } from '../../agent/shared-state.js';
import { dueOf } from '../../agent/v2/owed.js';
import { freshReplyDb, AGENT, PERSON, T0 } from '../../agent/v2/__tests__/helpers/reply-sender.js';
import { textFrom } from '../../agent/v2/__tests__/helpers/parked-agent.js';
import { samAsks, servedBy, turnEnds, askOf, countsOf, CONV } from './helpers/a-request-handed-back.js';

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  freshReplyDb(runMigrations);
  samAsks('m-1');
  servedBy('m-1', 1);
  const bag = openTurnContext(AGENT);
  bag.turnNumber = 1;
  bag.conversationId = CONV;
  bag.root = { kind: 'ask', id: 'm-1', sourceMessageId: 'm-1', conversationId: CONV };
  parkJob(AGENT, 'turn-budget');
  turnEnds(1, 'iteration_cap', { parkedTheJob: true });
  endTurnContext(AGENT);
});
afterEach(() => { endJobCarry(AGENT); pendingWakeups.delete(AGENT); });

describe('a parked job is not re-served by the clock', () => {
  it('the request is open with no due and nothing counted, and the clock leaves it to the continuation', () => {
    expect(askOf('m-1')).toEqual({ state: 'open', due: null });
    expect(countsOf('m-1')).toEqual({ silence: 0, engine: 0 });
    expect(parkedContinuationFor(AGENT)).toBe('m-1');
    expect(dueOf(AGENT).now).toBe(false);
  });

  it('another person waiting on the same agent is not hidden by the parked job', () => {
    expect(dueOf(AGENT).now).toBe(false);
    textFrom('m-2', PERSON, { relation: 'known_contact' });
    expect(dueOf(AGENT).now).toBe(true);
  });

  it('once the continuation has run and ended, the clock serves the request again', () => {
    expect(beginJobRun(AGENT, 'drain')).toBe(true);
    endJobRun(AGENT);
    expect(dueOf(AGENT).now).toBe(true);
  });
});
