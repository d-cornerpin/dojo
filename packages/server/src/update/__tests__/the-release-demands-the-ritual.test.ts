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
  const file = path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), `lane3-ritual-${Math.random().toString(36).slice(2)}.json`);
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
    drawUnsteered: true,
    pinnedDraws: [],
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
      'final', 'seed', 'families', 'seedFresh', 'drawUnsteered', 'pinnedDraws', 'dojoHead',
      'fixesAfterFinalDraw',
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
    // 2026-09-26, hours after the first replication: the kit's validator gained `final.drawUnsteered`
    // (a variant-PINNED draw is a rehearsal, so it can no more mint a shippable marker than a
    // --seed replay can), and this copy owes every field the kit checks.
    ['the draw cannot be proven unsteered', (m: ReturnType<typeof ritualMarker>) => { m.final.drawUnsteered = false; }, 'drawUnsteered'],
    ['a variant-pinned draw claims it was unsteered', (m: ReturnType<typeof ritualMarker>) => { m.final.pinnedDraws = ['memory-recall:variant']; }, 'contradicts itself'],
    // Review C, L3-F4: ten was a COUNT. Both of these passed — on the real script bytes AND in the
    // kit — so the TEN-RANDOM law's machine proof was satisfiable by ten copies of one scenario.
    ['ten EMPTY family names', (m: ReturnType<typeof ritualMarker>) => { m.final.families = Array.from({ length: 10 }, () => ''); }, 'non-empty'],
    ['ten IDENTICAL family names', (m: ReturnType<typeof ritualMarker>) => { m.final.families = Array.from({ length: 10 }, () => 'family-0'); }, 'distinct'],
    ['nine real families and one blank', (m: ReturnType<typeof ritualMarker>) => { m.final.families[3] = '   '; }, 'non-empty'],
  ])('RED: %s', (_label, mutate, expected) => {
    const marker = ritualMarker();
    mutate(marker);
    const why = verdictFor(marker);
    expect(why, 'the gate would have shipped this marker').not.toBe('');
    expect(why).toContain(expected);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE TWO COPIES, AND THE ORDER THEY DEPEND ON (review C, L3-F5).
//
// `release.sh` re-expresses `validateReleaseRitualMarker` because bash cannot import ESM across the
// sibling-repo boundary. That copy drifted within hours of being written (the kit gained
// `final.drawUnsteered` and the copy did not have it), and the field-name inventory above could not
// see it — an inventory only knows the names someone remembered to list. So the clauses below read
// BOTH sides and diff them, and they pin the one thing the division of labour rests on: ORDER.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The kit's ritual validator, when the sibling repo is here. `null` when it is not. */
function kitValidatorSource(): string | null {
  const candidates = [
    process.env.DOJO_TEST_KIT
      ? path.join(process.env.DOJO_TEST_KIT, 'behavioral/lib/release-ritual.mjs')
      : null,
    path.resolve(REPO_ROOT, '../dojo-test-kit/behavioral/lib/release-ritual.mjs'),
  ].filter((p): p is string => p !== null);
  for (const p of candidates) if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  return null;
}

/** Only the part of the kit module that VALIDATES, so the assembler's own field writes do not count. */
function kitValidatorBody(src: string): string {
  const i = src.indexOf('export function validateReleaseRitualMarker');
  expect(i, 'the kit module no longer exports validateReleaseRitualMarker — the copy has no original')
    .toBeGreaterThan(-1);
  return src.slice(i);
}

/** The ritual-specific fields BOTH sides must check. The four `green`/`verdicts`/`knownFailing`/
 *  `merged` questions are deliberately NOT here: release.sh's earlier K1 block owns them, which is
 *  exactly the ordering dependency the last clause pins. */
const RITUAL_FIELDS = [
  'release-ritual', 'blast', 'scenario', 'attempts', 'allGreen', 'gitSha',
  'final', 'seed', 'families', 'seedFresh', 'drawUnsteered', 'pinnedDraws',
  'dojoHead', 'fixesAfterFinalDraw',
];

describe('the copy and the original check the same fields', () => {
  it('release.sh names every ritual field (frozen list — cannot pass vacuously if the kit is absent)', () => {
    const block = extractRitualCheck('/nonexistent.json');
    for (const field of RITUAL_FIELDS) {
      expect(block, `the ritual check no longer mentions ${field}`).toContain(field);
    }
  });

  it('PARITY: every ritual field the kit validator checks is checked by the copy too', () => {
    const kit = kitValidatorSource();
    if (kit === null) {
      // Not a silent skip: the frozen list above still ran, and this says out loud what was not asked.
      expect(RITUAL_FIELDS.length, 'the sibling kit is absent, so parity could not be measured — the '
        + 'frozen-list clause above is the only guard in this run').toBeGreaterThan(0);
      return;
    }
    const body = kitValidatorBody(kit);
    const copy = extractRitualCheck('/nonexistent.json');
    const missing = RITUAL_FIELDS.filter((f) => body.includes(f) && !copy.includes(f));
    expect(missing, `the kit validator checks ${missing.join(', ')} and deploy/release.sh's copy does `
      + 'not — that is the drift this clause exists for; mirror the field in the same hour').toEqual([]);
    // ...and the other direction, so the copy cannot invent a demand the kit does not make.
    const extra = RITUAL_FIELDS.filter((f) => copy.includes(f) && !body.includes(f));
    expect(extra, `deploy/release.sh demands ${extra.join(', ')} and the kit validator does not — the `
      + 'release would refuse a marker the kit considers shippable').toEqual([]);
  });

  it('PARITY of the pinnedDraws shape: both sides filter to NON-EMPTY strings', () => {
    // L3-F5a: the copy tested `.length > 0` while the kit filtered to non-empty strings, so
    // `pinnedDraws: ['']` refused here and shipped there. Safe direction, but not equivalent.
    const copy = extractRitualCheck('/nonexistent.json');
    expect(copy, "the copy no longer filters pinnedDraws to non-empty strings").toMatch(/pinnedDraws[\s\S]{0,200}filter/);
    const marker = ritualMarker();
    (marker.final as { pinnedDraws: string[] }).pinnedDraws = [''];
    expect(verdictFor(marker), 'an empty pinnedDraws entry is not a steered draw and must not refuse')
      .toBe('');
    const kit = kitValidatorSource();
    if (kit !== null) expect(kitValidatorBody(kit)).toMatch(/pinnedDraws[\s\S]{0,200}filter/);
  });

  it('THE ORDERING CONTRACT: the K1 honesty block runs BEFORE the ritual block', () => {
    // L3-F5b: the ritual block does not re-check `green`, so a dishonest green is refused only
    // because BEHAV_DISHONEST already ran. Reorder or delete K1 and it ships past this gate.
    const sh = fs.readFileSync(RELEASE_SH, 'utf-8');
    const k1 = sh.indexOf('BEHAV_DISHONEST=$(node -e "');
    const ritual = sh.indexOf('RITUAL_BAD=$(node -e "');
    expect(k1, 'the BEHAV_DISHONEST (K1) block is gone — the ritual block does not re-check `green`, '
      + 'so nothing in the release refuses a dishonest green any more').toBeGreaterThan(-1);
    expect(ritual).toBeGreaterThan(-1);
    expect(k1, 'K1 now runs AFTER the ritual block; the ritual block relies on it having run')
      .toBeLessThan(ritual);
    // And the dependency is written down where a reader of either block will meet it.
    expect(sh, 'the ritual block does not disclose that it leans on K1').toMatch(/NOT SELF-SUFFICIENT/);
  });

  it('the ✓ line reports the field the gate CHECKED, not the unchecked `final.n`', () => {
    // L3-F6: a marker with `n: 3` and ten families made the success line announce "3 families".
    const sh = fs.readFileSync(RELEASE_SH, 'utf-8');
    const echoLine = sh.split('\n').find((l) => l.includes('release ritual proven')) ?? '';
    expect(echoLine).not.toBe('');
    expect(echoLine, 'the ✓ line still reads final.n, a number nothing above validates')
      .not.toMatch(/final\.n\b/);
    expect(echoLine, 'the ✓ line should report families.length').toMatch(/families\|\|\[\]\)\.length|families\|\| \[\]\)\.length/);
  });
});
