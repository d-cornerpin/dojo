// v3.5 field fix 3, review round L2: "working shows only when working". The catch-up's progress glyph says the agent's
// older memory is being summarised. When the compaction-failure notice speaks for the agent, nothing is moving, so the
// glyph ends, whatever the failing stage: the owner-repairable ones (a writer down) AND the ones he cannot repair. It
// comes back at the next turn on notes once the failure is over (`catchUpFailureOver`).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const catchUp = vi.hoisted(() => ({ withdraw: vi.fn(), over: vi.fn() }));
vi.mock('../catch-up-state.js', () => ({ withdrawCatchUpProgress: catchUp.withdraw, catchUpFailureOver: catchUp.over }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../providers/billing-breaker.js', () => ({ providerBreaker: () => null }));
vi.mock('../../db/connection.js', () => ({ getDb: () => { throw new Error('no database in this unit test'); } }));

import { reportCompactionDefect, noteCompactionRecovered, __resetCompactionFailuresForTests } from '../compaction-defect.js';

const ZERO = { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };

beforeEach(() => {
  __resetCompactionFailuresForTests();
  catchUp.withdraw.mockClear();
  catchUp.over.mockClear();
});

describe('a compaction failure ends the catch-up glyph', () => {
  it('a stage the owner cannot repair (no yield) ends it too', () => {
    reportCompactionDefect('agent-a', 'no_yield', { assembledTokens: 900, budgetTokens: 500 }, ZERO);
    expect(catchUp.withdraw).toHaveBeenCalledWith('agent-a');
  });

  it('CONTROL: an owner-repairable stage (the writer down) ends it, as before', () => {
    reportCompactionDefect('agent-b', 'summary_writer_unavailable', { modelId: 'm' }, ZERO);
    expect(catchUp.withdraw).toHaveBeenCalledWith('agent-b');
  });

  it('the failure over: the glyph may come back at the next turn on notes', () => {
    reportCompactionDefect('agent-c', 'no_yield', {}, ZERO);
    noteCompactionRecovered('agent-c', 4_000);
    expect(catchUp.over).toHaveBeenCalledWith('agent-c');
  });
});
