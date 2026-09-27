// ════════════════════════════════════════════════════════════════════════════════════════
// LANE-3 — THE RELEASE GATE DEMANDS THE RITUAL, AND THIS IS WHAT PROVES THE DEMAND BITES.
//
// ── THE HOLE, MEASURED ──
// `grep -c ritual deploy/release.sh` was ZERO. The owner's 2026-09-20 ruling makes every cut prove
// TWO things — 3 green attempts of a blast-radius scenario, then a FRESH 10-family generated draw,
// all green, both at the same platform commit — and `dojo-test-kit/behavioral/lib/release-ritual.mjs`
// assembles a marker that records them. But the release's behavioural gate only asked: green, under
// 24h, this HEAD, floor model. An ORDINARY green marker satisfies every one of those, so a cut with
// no blast proof and no 10-family draw walked straight through the gate the ruling stands behind.
//
// ── WHY THE CHECK IS A COPY, AND WHY THAT COPY NEEDS THIS FILE ──
// The kit's module header names the release gate as the second, deliberate copy of
// `validateReleaseRitualMarker`: `release.sh` runs in bash and cannot import ESM across the
// sibling-repo boundary, exactly as its own BEHAV_DISHONEST and MODEL_MISMATCH checks cannot. A
// hand-maintained copy of someone else's predicate is a drift surface, and the thing that makes
// this one honest is that the copy is EXECUTED here against fixture markers rather than read.
//
// So this suite EXTRACTS the `RITUAL_BAD` script out of `deploy/release.sh` and runs the real
// bytes: the happy path must pass, and every planted fault must refuse with its own sentence. A
// future edit that weakens the copy — deletes a field check, softens `=== 3`, drops the
// same-commit equality — fails here rather than at the next release that should not have shipped.
//
// It lives beside `update-cannot-brick.test.ts` for that file's reason: both are vitest files under
// `packages/server/src`, so both ride the `unit-suite` release gate, which release.sh runs and
// which is never skippable. A clause that guards a release gate has to be in something the release
// itself runs.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const RELEASE_SH = path.join(REPO_ROOT, 'deploy/release.sh');

/** A 40-char sha, the shape `git rev-parse HEAD` returns. */
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/**
 * The `RITUAL_BAD` script as release.sh really carries it, with the two shell variables the
 * script interpolates substituted the way bash would.
 *
 * The anchor is asserted separately below: an extraction that silently finds nothing would make
 * every clause here pass by having nothing to run, which is the failure shape these suites exist
 * to prevent.
 */
function extractRitualCheck(markerPath: string): string {
  const sh = fs.readFileSync(RELEASE_SH, 'utf-8');
  const m = /RITUAL_BAD=\$\(node -e "([\s\S]*?)"\)\n/.exec(sh);
  if (!m) throw new Error('no RITUAL_BAD=$(node -e "...") block in deploy/release.sh');
  return m[1].replace(/\$BEHAV_MARKER/g, markerPath).replace(/\$HEAD_SHA/g, HEAD);
}

/** What the gate says about one marker: '' = it would ship, anything else = the refusal reasons. */
function verdictFor(marker: unknown): string {
  const file = path.join(os.tmpdir(), `lane3-ritual-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(marker));
  try {
    return execFileSync(process.execPath, ['-e', extractRitualCheck(file)], { encoding: 'utf-8' }).trim();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** A marker that proves the whole ritual: the shape `assembleReleaseRitualMarker` produces. */
const ritualMarker = () => ({
  green: true,
  gitSha: HEAD,
  dojoHead: HEAD,
  mode: 'release-ritual',
  fixesAfterFinalDraw: false,
  blast: { scenario: 'blast-radius-x.mjs', attempts: 3, allGreen: true, gitSha: HEAD },
  final: {
    seed: 'f1d22d892260',
    families: Array.from({ length: 10 }, (_, i) => `family-${i}`),
    n: 10,
    allGreen: true,
    seedFresh: true,
  },
});

describe('LANE-3 — release.sh carries the ritual check at all', () => {
  it('the block exists, and the word the ruling turns on is in the script', () => {
    const sh = fs.readFileSync(RELEASE_SH, 'utf-8');
    expect(sh, 'deploy/release.sh has no RITUAL_BAD block — the ritual demand was deleted')
      .toMatch(/RITUAL_BAD=\$\(node -e "/);
    expect(sh, 'the refusal must name the two kit commands that produce a ritual marker')
      .toMatch(/--blast/);
    // The extraction anchor this whole file depends on. If the block is rewritten into another
    // shape, say THAT rather than passing every clause below on an empty script.
    expect(() => extractRitualCheck('/nonexistent.json')).not.toThrow();
  });

  it('the copy still checks every field the kit validator checks', () => {
    // A field-name inventory, not a behaviour assertion: the clauses below prove the behaviour.
    // This one catches a deletion that happens to leave the happy path passing.
    const block = extractRitualCheck('/nonexistent.json');
    for (const field of [
      'release-ritual', 'blast', 'scenario', 'attempts', 'allGreen', 'gitSha',
      'final', 'seed', 'families', 'seedFresh', 'dojoHead', 'fixesAfterFinalDraw',
    ]) {
      expect(block, `the ritual check no longer mentions ${field}`).toContain(field);
    }
  });
});

describe('LANE-3 — a full ritual marker ships', () => {
  it('CONTROL: the happy path passes, so the gate is not simply refusing everything', () => {
    expect(verdictFor(ritualMarker())).toBe('');
  });
});

describe('LANE-3 — every way the ritual can be unproven is refused', () => {
  // THE HOLE ITSELF, first: this is the marker an ordinary `node behavioral/runner.mjs` green
  // writes, and before this gate existed it shipped.
  it('RED: a plain non-ritual green marker is refused, naming what is missing', () => {
    const plain = ritualMarker() as Record<string, unknown>;
    delete plain.mode; delete plain.blast; delete plain.final; delete plain.fixesAfterFinalDraw;
    const why = verdictFor(plain);
    expect(why).not.toBe('');
    expect(why).toContain('mode=undefined');
    expect(why).toContain('blast');
    expect(why).toContain('final');
  });

  it.each([
    ['the blast attempts were not all green', (m: ReturnType<typeof ritualMarker>) => { m.blast.allGreen = false; }, 'blast.allGreen'],
    ['only two blast attempts ran', (m: ReturnType<typeof ritualMarker>) => { m.blast.attempts = 2; }, 'needs exactly 3'],
    ['the blast scenario is not recorded', (m: ReturnType<typeof ritualMarker>) => { m.blast.scenario = ''; }, 'blast.scenario'],
    ['the final draw was a --seed replay', (m: ReturnType<typeof ritualMarker>) => { m.final.seedFresh = false; }, 'seedFresh'],
    ['nine families instead of ten', (m: ReturnType<typeof ritualMarker>) => { m.final.families.pop(); }, 'needs exactly 10'],
    ['a family went red', (m: ReturnType<typeof ritualMarker>) => { m.final.allGreen = false; }, 'final.allGreen'],
    ['the draw is not replayable', (m: ReturnType<typeof ritualMarker>) => { m.final.seed = ''; }, 'final.seed'],
    ['a fix landed between the blast and the draw', (m: ReturnType<typeof ritualMarker>) => { m.blast.gitSha = OTHER; }, 'landed between'],
    ['the ritual proved a different tree', (m: ReturnType<typeof ritualMarker>) => { m.dojoHead = OTHER; m.gitSha = OTHER; }, 'not the tree being shipped'],
    ['a fix landed after the final draw', (m: ReturnType<typeof ritualMarker>) => { m.fixesAfterFinalDraw = true; }, 'fixesAfterFinalDraw'],
  ])('RED: %s', (_label, mutate, expected) => {
    const marker = ritualMarker();
    mutate(marker);
    const why = verdictFor(marker);
    expect(why, 'the gate would have shipped this marker').not.toBe('');
    expect(why).toContain(expected);
  });
});
