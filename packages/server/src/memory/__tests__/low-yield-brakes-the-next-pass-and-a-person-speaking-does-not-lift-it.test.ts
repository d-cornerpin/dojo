// A pass that bought almost nothing brakes the next routine pass; a forced pass that won nothing brakes the next
// forced pass too. A person writing to the agent frees its waiting writers but does not lift the brake: only the
// clock, a reset, a model change, a shrunken history or the writer's provider answering again do.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const facts = vi.hoisted(() => ({ seq: 10, session: 's1', model: 'm' }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => facts, all: () => [], run: () => ({ changes: 0 }) }) }),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { compactionIsBraked, notePassOutcome, LOW_YIELD_BACKOFF_MS, __resetBrakesForTests } from '../compaction-brakes.js';
import { clearOn } from '../writer.js';

const AGENT = 'agent-low-yield';
const SMALL = { leafCreated: 1, condensedCreated: 0, tokensReclaimed: 1_500 };
const NOTHING = { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };

beforeEach(() => { __resetBrakesForTests(); facts.model = 'm'; });

describe('low yield brakes the next pass, and a person speaking does not lift it', () => {
  it('a low-yield pass brakes the next routine pass, never an emergency', () => {
    notePassOutcome(AGENT, false, SMALL, { lowYield: true });
    expect(compactionIsBraked(AGENT, false)).toBe(true);
    expect(compactionIsBraked(AGENT, true)).toBe(false);
  });

  it('a forced pass that won nothing brakes the next forced pass; a person speaking leaves it on', () => {
    notePassOutcome(AGENT, true, NOTHING);
    clearOn({ kind: 'person-spoke', agentId: AGENT });
    expect(compactionIsBraked(AGENT, true)).toBe(true);
  });

  it('it always lets go: a model change, or the clock', () => {
    notePassOutcome(AGENT, true, NOTHING);
    facts.model = 'm2';
    expect(compactionIsBraked(AGENT, true)).toBe(false);
    notePassOutcome(AGENT, true, NOTHING);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + LOW_YIELD_BACKOFF_MS + 1 });
    try { expect(compactionIsBraked(AGENT, true)).toBe(false); } finally { vi.useRealTimers(); }
  });
});
