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

import { recordingForcedPass, __resetForcedPassProgressForTests } from '../forced-pass-progress.js';
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
    expect(compaction).toMatch(/options\?\.force \? recordingForcedPass\(agentId, \(\) => runCheckAndCompact\(/);
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
