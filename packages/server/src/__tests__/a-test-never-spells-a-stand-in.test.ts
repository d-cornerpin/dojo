// ════════════════════════════════════════════════════════════════════════════
// NO TEST SPELLS A STAND-IN NAME (v3.5): the invented names come from ONE module, `deploy/checks/fixture-vocabulary.mjs`.
//
// BEFORE: ~190 test files each spelled out a coined stand-in name, so the day an owner named a real agent after one, the repair was a
// 190-file rename. NOW: a test takes a slot from the shared vocabulary (`FX.n4`), the slots are filled from `deploy/checks/fixture-names.json`,
// and a collision is a one-line registry edit. This clause is what keeps it that way: a registered stand-in written as a literal in a
// test file (code, string, or comment) is a failure that names the file and the line, and the fix it asks for is the import.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry, wordRe } from '../../../../deploy/checks/fixture-names.mjs';
import { FX, FXID, FXUP, SLOT_COUNT } from '../../../../deploy/checks/fixture-vocabulary.mjs';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const TEST_FILE = /^packages\/[^/]+\/src\/.*(?:(?:^|\/)__tests__\/|\.(?:test|spec)\.tsx?$)/;

describe('the shared fixture vocabulary', () => {
  it('has one slot per registered stand-in, in registry order, in three casings', () => {
    const { standIns } = loadRegistry();
    expect(SLOT_COUNT).toBe(standIns.length);
    standIns.forEach((w, i) => {
      expect(FX[`n${i + 1}`]).toBe(w);
      expect(FXID[`n${i + 1}`]).toBe(w.toLowerCase());
      expect(FXUP[`n${i + 1}`]).toBe(w.toUpperCase());
    });
  });

  it('refuses a slot that does not exist instead of handing back "undefined"', () => {
    expect(() => FX[`n${SLOT_COUNT + 1}`]).toThrow(/no slot/);
    expect(() => FX.typo).toThrow(/no slot/);
  });
});

describe('no test file spells a registered stand-in name', () => {
  it('every test reads its invented names from the shared vocabulary', () => {
    const { standIns } = loadRegistry();
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0').filter((f) => TEST_FILE.test(f) && /\.(?:ts|tsx)$/.test(f));
    const offenders: string[] = [];
    for (const rel of files) {
      let text: string;
      try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; } // deleted in the working tree
      text.split('\n').forEach((line, i) => {
        for (const w of standIns) if (wordRe(w).test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      'a registered stand-in is spelled out in a test. Import { FX, FXID, FXUP } from deploy/checks/fixture-vocabulary.mjs and use a slot (FX.n4), so a name collision is a one-line registry edit and never a many-file rename',
    ).toEqual([]);
  });
});
