// Every forced pass records its outcome on every return path, inside the one compaction door: a pass that bought
// nothing arms the brake, a genuine stall (over budget with nothing left that can shrink) is reported once, a throw
// is recorded per pass, and the owner's compact-now borrows a running pass's progress only when the view then fits.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => ({ hi: 1, session: null, model: 'm' }), all: () => [], run: () => ({ changes: 0 }) }) }),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { compactionDoor, lastForcedPass, compactionBrakeMsLeft, notePassOutcome, __resetBrakesForTests } from '../compaction-brakes.js';
import { compactionFailureReason } from '../compaction-defect.js';

const AGENT = 'agent-forced-pass';
const NOTHING = { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
const fits = async () => ({ assembledTokens: 900, budgetTokens: 1_000 });
const over = async () => ({ assembledTokens: 2_000, budgetTokens: 1_000 });

beforeEach(() => { __resetBrakesForTests(); });

describe('the owner\'s compact-now waits for a running pass', () => {
  it('the owner\'s compact-now (D18 r5, ruling 4): after the running pass it runs its own unless that pass left the view fitting', async () => {
    const won = { leafCreated: 1, condensedCreated: 0, tokensReclaimed: 3_000 };
    const mine = { leafCreated: 2, condensedCreated: 0, tokensReclaimed: 4_000 };
    let release!: () => void;
    const held = compactionDoor(AGENT, () => new Promise<typeof won>((r) => { release = () => r(won); }));
    const still = compactionDoor(AGENT, async () => mine, { measure: over });
    await new Promise((r) => setImmediate(r));
    release(); await held;
    expect(await still, 'the view still needs it: its own pass ran').toEqual({ ...mine, byRunningPass: false });
    const held2 = compactionDoor(AGENT, () => new Promise<typeof won>((r) => { release = () => r(won); }));
    const fitting = compactionDoor(AGENT, async () => mine, { measure: fits });
    await new Promise((r) => setImmediate(r));
    release(); await held2;
    expect(await fitting, 'the running pass left the view fitting: that is what it reports').toEqual({ ...won, byRunningPass: true });
  });

});

describe('the throw flag is per pass', () => {
  it('throw, then a pass that runs and returns: the flag is clear, so a later stall is reported', async () => {
    await expect(compactionDoor(AGENT, async () => { throw new Error('boom'); }, { measure: over })).rejects.toThrow('boom');
    expect(lastForcedPass(AGENT).threw).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * 60_000 });
    try { await compactionDoor(AGENT, async () => NOTHING, { measure: over }); } finally { vi.useRealTimers(); }
    expect(lastForcedPass(AGENT).threw, 'the last pass that ran did not throw').toBe(false);
  });

  it('a braked skip did not run, so it leaves the flag as it was (two throws a brake apart are still "again")', async () => {
    await expect(compactionDoor(AGENT, async () => { throw new Error('boom'); }, { measure: over })).rejects.toThrow();
    await compactionDoor(AGENT, async () => NOTHING, { measure: over });   // the brake is on: a skip
    expect(lastForcedPass(AGENT).threw).toBe(true);
  });
});

describe('every return shape records', () => {
  it('a pass that returned NOTHING recorded (the leaf-less early return) arms the brake', async () => {
    await compactionDoor(AGENT, async () => NOTHING, { measure: fits });
    expect(compactionBrakeMsLeft(AGENT)).not.toBeNull();
    expect(compactionFailureReason(AGENT), 'under budget: no defect').toBeNull();
  });

  it('over budget with nothing left that can shrink is a genuine stall, reported ONCE as a defect', async () => {
    await compactionDoor(AGENT, async () => NOTHING, { measure: over });
    expect(compactionFailureReason(AGENT)).toBe('nothing_left_to_shrink');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * 60_000 });
    try { await compactionDoor(AGENT, async () => NOTHING, { measure: over }); } finally { vi.useRealTimers(); }
    expect(compactionFailureReason(AGENT), 'one note per outage').toBe('nothing_left_to_shrink');
  });

  it('a braked skip leaves the brake as it was (its clock is not pushed out)', async () => {
    notePassOutcome(AGENT, true, NOTHING);
    const before = compactionBrakeMsLeft(AGENT)!;
    await new Promise((r) => setTimeout(r, 15));
    await compactionDoor(AGENT, async () => NOTHING, { measure: fits });
    expect(compactionBrakeMsLeft(AGENT)!).toBeLessThanOrEqual(before);
  });

  it('a pass its caller cancelled records nothing; a pass that made progress clears the brake', async () => {
    const ctl = new AbortController(); ctl.abort();
    await compactionDoor(AGENT, async () => NOTHING, { measure: fits, abortSignal: ctl.signal });
    expect(compactionBrakeMsLeft(AGENT)).toBeNull();
    notePassOutcome(AGENT, true, NOTHING);
    await compactionDoor(AGENT, async () => { const r = { leafCreated: 1, condensedCreated: 0, tokensReclaimed: 3_000 }; notePassOutcome(AGENT, true, r); return r; }, { measure: fits });
    expect(compactionBrakeMsLeft(AGENT)).toBeNull();
  });
});
