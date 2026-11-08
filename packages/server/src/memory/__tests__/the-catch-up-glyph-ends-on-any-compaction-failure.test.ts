// "Working shows only when working": the catch-up's progress glyph says older memory is being summarised. When the
// compaction-failure notice speaks for the agent, nothing is moving, so the glyph ends, whatever the failing stage.
// While the failure stands the glyph is not shown again; once it is over, the next turn on notes shows it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const catchUp = vi.hoisted(() => ({ withdraw: vi.fn() }));
vi.mock('../out-of-view.js', () => ({ withdrawCatchUpProgress: catchUp.withdraw }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../providers/billing-breaker.js', () => ({ providerBreaker: () => null }));
vi.mock('../../db/connection.js', () => ({ getDb: () => { throw new Error('no database in this unit test'); } }));

import { reportCompactionDefect, noteCompactionRecovered, compactionFailureReason, __resetCompactionFailuresForTests } from '../compaction-defect.js';

const ZERO = { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };

beforeEach(() => {
  __resetCompactionFailuresForTests();
  catchUp.withdraw.mockClear();
});

describe('a compaction failure ends the catch-up glyph', () => {
  it('a stage the owner cannot repair (no yield) ends it too', async () => {
    reportCompactionDefect('agent-a', 'no_yield', { assembledTokens: 900, budgetTokens: 500 }, ZERO);
    await vi.waitFor(() => expect(catchUp.withdraw).toHaveBeenCalled());
    expect(catchUp.withdraw).toHaveBeenCalledWith('agent-a');
  });

  it('CONTROL: an owner-repairable stage (the writer down) ends it, as before', async () => {
    reportCompactionDefect('agent-b', 'summary_writer_unavailable', { modelId: 'm' }, ZERO);
    await vi.waitFor(() => expect(catchUp.withdraw).toHaveBeenCalled());
    expect(catchUp.withdraw).toHaveBeenCalledWith('agent-b');
  });

  it('the failure over: nothing speaks for the agent any more, so the glyph may come back', () => {
    reportCompactionDefect('agent-c', 'no_yield', {}, ZERO);
    expect(compactionFailureReason('agent-c')).toBe('no_yield');
    noteCompactionRecovered('agent-c', 4_000);
    expect(compactionFailureReason('agent-c')).toBeNull();
  });
});
