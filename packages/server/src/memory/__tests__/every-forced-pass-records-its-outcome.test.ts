// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 D18 fix round 3 — EVERY FORCED PASS RECORDS ITS OUTCOME, ON EVERY RETURN PATH, STRUCTURALLY.
//
// A forced pass that returned without `notePassOutcome` (the leaf-less early return in `compaction.ts`,
// reached by the recovery door's context-overflow pass) armed no brake, so the park woke the agent at
// once into the same wall — the t168 class. The outcome is now recorded inside the forced-pass door
// itself (`recordingForcedPass`, which `checkAndCompact` runs every forced pass through), not by each
// caller. A no-progress outcome carries its facts: over budget with nothing left that can shrink is a
// genuine stall, reported once through the existing compaction-defect path.
//   §1 the census: every forced caller goes through `checkAndCompact`, and every forced run of it
//      through `recordingForcedPass`;
//   §2 the door: each return shape leaves the brake saying what the pass bought.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => ({ hi: 1, session: null, model: 'm' }), all: () => [], run: () => ({ changes: 0 }) }) }),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { recordingForcedPass, forcedPassDoor, lastForcedPassThrew, finishedUnderTheLock, passesFinished, afterTheRunningPass, __resetForcedPassProgressForTests } from '../forced-pass-progress.js';
import { compactionBrakeMsLeft, notePassOutcome, __resetBrakesForTests } from '../compaction-brakes.js';
import { compactionFailureReason } from '../compaction-defect.js';

const SRC = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
function productionFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : productionFiles(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

const AGENT = 'agent-forced-pass';
const NOTHING = { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
const fits = async () => ({ assembledTokens: 900, budgetTokens: 1_000 });
const over = async () => ({ assembledTokens: 2_000, budgetTokens: 1_000 });

beforeEach(() => { __resetBrakesForTests(); __resetForcedPassProgressForTests(); });

describe('§1 the census', () => {
  it('the forced run of checkAndCompact goes through recordingForcedPass, and the pass itself is not exported', () => {
    const compaction = read('memory/compaction.ts');
    expect(compaction).toMatch(/if \(options\?\.force\) \{\n\s+forcedPassAt\.set\(agentId, Date\.now\(\)\);\n\s+return forcedPassDoor\(agentId, \(\) => runCheckAndCompact\(/);   // v3.5 D18 r4: the one door
    expect(compaction).not.toMatch(/export async function runCheckAndCompact/);
  });

  it('every production caller that forces a pass calls checkAndCompact — the one door', () => {
    const forcing = productionFiles(SRC).filter((f) => {
      const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');   // code, not comments
      return /checkAndCompact\(/.test(code) && /force: true|forcedCompactionOptions\(/.test(code) && !f.endsWith(path.join('memory', 'compaction.ts')) && !f.endsWith('compaction-brakes.ts');
    }).map((f) => path.relative(SRC, f)).sort();
    expect(forcing).toEqual(['agent/v2/recovery.ts', 'gateway/routes/memory.ts', 'memory/assembly-validation.ts']);
    expect(productionFiles(SRC).filter((f) => /runCheckAndCompact\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f))).toEqual(['memory/compaction.ts']);
  });
});

describe('§1b fix rounds 4-5: a busy lock is handled inside the door, and no caller can opt out', () => {
  const code = (rel: string): string => read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  it('the forced run always waits for the lock; only an unforced run can skip', () => {
    const progress = code('memory/forced-pass-progress.ts');
    const door = progress.slice(progress.indexOf('export async function forcedPassDoor('), progress.indexOf('/** Test-only reset'));
    // v3.5 D18 r5: a turn's pass is TOLD the lock is busy (never a silent zero); the owner's waits.
    expect(door, 'inside a turn: a busy lock answers lockBusy').toMatch(/if \(opts\.inTurn\) return \(await withLock\(lock, own, \{ ifBusy: 'skip' \}\)\) \?\? \{[^}]*lockBusy: true \};/);
    expect(door, 'otherwise the door waits').toMatch(/\}, \{ ifBusy: 'wait' \}\);/);
    expect(door.match(/ifBusy:/g), 'no third way').toHaveLength(2);
    expect(door, 'a pass that runs records').toMatch(/const own = \(\): Promise<PassResult> => finishedUnderTheLock\(agentId, \(\) => recordingForcedPass\(agentId, run, opts\)\);/);
    const compaction = code('memory/compaction.ts');
    const entry = compaction.slice(compaction.indexOf('export async function checkAndCompact('), compaction.indexOf('async function runCheckAndCompact('));
    expect(entry.match(/withLock\(/g), 'one lock call in the entry, after the forced branch returned').toHaveLength(1);
    expect(entry.indexOf('return forcedPassDoor(')).toBeLessThan(entry.indexOf('withLock('));
    expect(entry, 'the unforced run skips').toMatch(/withLock\([^\n]*\{ ifBusy: 'skip' \}\);/);
  });

  it('every forced caller inside a turn says so (`inTurn: true`): it never waits, it parks; only the owner\'s compact-now waits', () => {
    for (const rel of ['agent/v2/recovery.ts', 'memory/assembly-validation.ts']) expect(code(rel), rel).toMatch(/inTurn: true/);
    expect(code('gateway/routes/memory.ts')).not.toMatch(/inTurn/);
    expect(code('agent/v2/recovery.ts'), 'the recovery door parks on a busy lock').toMatch(/lockBusy\) \{ parkUntilCompactionLands\(/);
    expect(code('agent/v2/over-budget-assembly.ts'), 'the over-budget door parks on a busy lock').toMatch(/lockBusy[^\n]*parkUntilCompactionLands\(/);
  });

  it('no production file carries a way to skip a forced pass (`waitIfBusy` is gone)', () => {
    expect(productionFiles(SRC).filter((f) => /waitIfBusy/.test(code(path.relative(SRC, f)))).map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('the owner\'s compact-now (D18 r5, ruling 4): after the running pass it runs its own unless that pass left the view fitting', async () => {
    const won = { leafCreated: 1, condensedCreated: 0, tokensReclaimed: 3_000 };
    const mine = { leafCreated: 2, condensedCreated: 0, tokensReclaimed: 4_000 };
    let release!: () => void;
    const { withLock } = await import('../../db/with-lock.js');
    const held = withLock(`compact:${AGENT}`, () => finishedUnderTheLock(AGENT, () => new Promise<typeof won>((r) => { release = () => r(won); })), { ifBusy: 'wait' });
    const still = forcedPassDoor(AGENT, async () => mine, { measure: over });
    await new Promise((r) => setImmediate(r));
    release(); await held;
    expect(await still, 'the view still needs it: its own pass ran').toEqual({ ...mine, byRunningPass: false });
    const held2 = withLock(`compact:${AGENT}`, () => finishedUnderTheLock(AGENT, () => new Promise<typeof won>((r) => { release = () => r(won); })), { ifBusy: 'wait' });
    const fitting = forcedPassDoor(AGENT, async () => mine, { measure: fits });
    await new Promise((r) => setImmediate(r));
    release(); await held2;
    expect(await fitting, 'the running pass left the view fitting: that is what it reports').toEqual({ ...won, byRunningPass: true });
  });

  it('after the running pass: its progress is the answer; no progress, or no pass finished, and this pass runs', async () => {
    const queued = passesFinished(AGENT);
    expect(afterTheRunningPass(AGENT, queued), 'nothing finished while it waited').toBeNull();
    await finishedUnderTheLock(AGENT, async () => NOTHING);
    expect(afterTheRunningPass(AGENT, queued), 'the running pass bought nothing').toBeNull();
    const won = { leafCreated: 1, condensedCreated: 0, tokensReclaimed: 3_000 };
    await finishedUnderTheLock(AGENT, async () => won);
    expect(afterTheRunningPass(AGENT, queued)).toEqual(won);
    expect(afterTheRunningPass(AGENT, passesFinished(AGENT)), 'a pass that finished before it queued is not the answer').toBeNull();
  });
});

describe('§3 fix round 4: the throw flag is per pass', () => {
  it('throw, then a pass that runs and returns: the flag is clear, so a later stall is reported', async () => {
    await expect(recordingForcedPass(AGENT, async () => { throw new Error('boom'); }, { measure: over })).rejects.toThrow('boom');
    expect(lastForcedPassThrew(AGENT)).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * 60_000 });
    try { await recordingForcedPass(AGENT, async () => NOTHING, { measure: over }); } finally { vi.useRealTimers(); }
    expect(lastForcedPassThrew(AGENT), 'the last pass that ran did not throw').toBe(false);
  });

  it('a braked skip did not run, so it leaves the flag as it was (two throws a brake apart are still "again")', async () => {
    await expect(recordingForcedPass(AGENT, async () => { throw new Error('boom'); }, { measure: over })).rejects.toThrow();
    await recordingForcedPass(AGENT, async () => NOTHING, { measure: over });   // the brake is on: a skip
    expect(lastForcedPassThrew(AGENT)).toBe(true);
  });
});

describe('§2 every return shape records', () => {
  it('a pass that returned NOTHING recorded (the leaf-less early return) arms the brake', async () => {
    await recordingForcedPass(AGENT, async () => NOTHING, { measure: fits });
    expect(compactionBrakeMsLeft(AGENT)).not.toBeNull();
    expect(compactionFailureReason(AGENT), 'under budget: no defect').toBeNull();
  });

  it('over budget with nothing left that can shrink is a genuine stall, reported ONCE as a defect', async () => {
    await recordingForcedPass(AGENT, async () => NOTHING, { measure: over });
    expect(compactionFailureReason(AGENT)).toBe('nothing_left_to_shrink');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * 60_000 });
    try { await recordingForcedPass(AGENT, async () => NOTHING, { measure: over }); } finally { vi.useRealTimers(); }
    expect(compactionFailureReason(AGENT), 'one note per outage').toBe('nothing_left_to_shrink');
  });

  it('a braked skip leaves the brake as it was (its clock is not pushed out)', async () => {
    notePassOutcome(AGENT, true, NOTHING);
    const before = compactionBrakeMsLeft(AGENT)!;
    await new Promise((r) => setTimeout(r, 15));
    await recordingForcedPass(AGENT, async () => NOTHING, { measure: fits });
    expect(compactionBrakeMsLeft(AGENT)!).toBeLessThanOrEqual(before);
  });

  it('a pass its caller cancelled records nothing; a pass that made progress clears the brake', async () => {
    const ctl = new AbortController(); ctl.abort();
    await recordingForcedPass(AGENT, async () => NOTHING, { measure: fits, abortSignal: ctl.signal });
    expect(compactionBrakeMsLeft(AGENT)).toBeNull();
    notePassOutcome(AGENT, true, NOTHING);
    await recordingForcedPass(AGENT, async () => { const r = { leafCreated: 1, condensedCreated: 0, tokensReclaimed: 3_000 }; notePassOutcome(AGENT, true, r); return r; }, { measure: fits });
    expect(compactionBrakeMsLeft(AGENT)).toBeNull();
  });
});
