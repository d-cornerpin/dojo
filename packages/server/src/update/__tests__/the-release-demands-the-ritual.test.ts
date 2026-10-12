// ════════════════════════════════════════════════════════════════════════════════════════
// LANE-3 — THE RELEASE GATE DEMANDS THE RITUAL, AND THIS IS WHAT PROVES THE DEMAND BITES.
//
// ── THE HOLE, MEASURED ──
// `grep -c ritual deploy/release.sh` was ZERO. The owner's ruling makes every cut prove its own
// fixes held, and `dojo-test-kit/behavioral/lib/release-ritual.mjs` assembles a marker that records
// it. But the release's behavioural gate only asked: green, under 24h, this HEAD, floor model. An
// ORDINARY green marker satisfies every one of those, so a cut with no ritual proof at all walked
// straight through the gate the ruling stands behind.
//
// ── THE SHAPE THESE CLAUSES NOW DRIVE (owner redesign, 2026-10-11) ──
// His words: "we need to remove the random scenarios run before each cut. Instead, I want 5
// targeted scenarios against the things being fixed to make sure the fixes hold." So the proof is
// FIVE hand-authored scenarios, each aimed at something THIS cut fixes, each run 3 times with
// UNANIMITY (the 2026-09-20 blast discipline, generalised), ALL at ONE platform commit. The
// ten-random generated draw is gone from the cut path; the v1 marker shape (blast{} + final{}) is a
// NAMED refusal, not a silent accept, because it is a complete once-shippable object that proves a
// ritual this project no longer runs. v3.3.2 shipped under v1; the first v2 cut is the next one.
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
// same-commit equality, re-admits the v1 shape — fails here rather than at the next release that
// should not have shipped.
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
  ritualVersion: 2,
  targetedVersion: 'v9.9.9',
  fixesAfterFinalDraw: false,
  targeted: Array.from({ length: 5 }, (_, i) => ({
    id: `targeted-probe-0${i + 1}`,
    attempts: 3,
    passCount: 3,
    allGreen: true,
    gitSha: HEAD,
  })),
});

/** The pre-redesign marker shape, verbatim — now a refusal, and an important one. */
const v1Marker = () => ({
  green: true,
  gitSha: HEAD,
  dojoHead: HEAD,
  mode: 'release-ritual',
  fixesAfterFinalDraw: false,
  blast: { scenario: 'v3.3.2', attempts: 3, allGreen: true, gitSha: HEAD },
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

/** The ritual-specific fields BOTH sides must check. The four `green`/`verdicts`/`knownFailing`/
 *  `merged` questions are deliberately NOT here: release.sh's earlier K1 block owns them, which is
 *  exactly the ordering dependency the last clause pins. `blast`/`final` ARE here — after the
 *  redesign both sides must still NAME the v1 objects, to refuse them. */
const RITUAL_FIELDS = [
  'release-ritual', 'ritualVersion', 'targetedVersion', 'targeted',
  'attempts', 'passCount', 'allGreen', 'gitSha',
  'dojoHead', 'fixesAfterFinalDraw', 'blast', 'final',
];

describe('LANE-3 — release.sh carries the ritual check at all', () => {
  it('the block exists, and the word the ruling turns on is in the script', () => {
    const sh = fs.readFileSync(RELEASE_SH, 'utf-8');
    expect(sh, 'deploy/release.sh has no RITUAL_BAD block — the ritual demand was deleted')
      .toMatch(/RITUAL_BAD=\$\(node -e "/);
    expect(sh, 'the refusal must name the kit command that produces a ritual marker')
      .toMatch(/--targeted/);
    expect(sh, 'the ten-random draw must not be demanded any more (the owner removed it from the cut path)')
      .not.toMatch(/needs exactly 10/);
    // The extraction anchor this whole file depends on. If the block is rewritten into another
    // shape, say THAT rather than passing every clause below on an empty script.
    expect(() => extractRitualCheck('/nonexistent.json')).not.toThrow();
  });

  it('the copy still checks every field the kit validator checks', () => {
    // A field-name inventory, not a behaviour assertion: the clauses below prove the behaviour.
    // This one catches a deletion that happens to leave the happy path passing.
    const block = extractRitualCheck('/nonexistent.json');
    for (const field of RITUAL_FIELDS) {
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
    delete plain.mode; delete plain.ritualVersion; delete plain.targetedVersion;
    delete plain.targeted; delete plain.fixesAfterFinalDraw;
    const why = verdictFor(plain);
    expect(why).not.toBe('');
    expect(why).toContain('mode=undefined');
    expect(why).toContain('targeted[]');
    expect(why).toContain('targetedVersion');
  });

  // THE HONEST MIGRATION. A v1 marker is complete, internally consistent, and was shippable
  // yesterday — which is precisely why it must be refused BY NAME rather than ignored. Accepting it
  // would certify a cut against a ritual nobody ran; quietly dropping its v1 fields would let one
  // marker carry two contradictory stories.
  it('RED: a complete v1 (blast + ten-random) marker is refused, naming the redesign', () => {
    const why = verdictFor(v1Marker());
    expect(why, 'the v1 marker shape still ships — the redesign was not enforced').not.toBe('');
    expect(why).toContain('2026-10-11');
    expect(why).toContain('blast{}');
    expect(why).toContain('final{}');
    expect(why).toContain('--targeted');
  });

  it.each([
    ['one of the five was not all green', (m: ReturnType<typeof ritualMarker>) => { m.targeted[0].allGreen = false; }, 'allGreen'],
    ['one scenario ran only two attempts', (m: ReturnType<typeof ritualMarker>) => { m.targeted[1].attempts = 2; }, 'needs exactly 3'],
    ['one scenario passed two of its three attempts', (m: ReturnType<typeof ritualMarker>) => { m.targeted[2].passCount = 2; }, 'unanimity'],
    ['one scenario is not identified', (m: ReturnType<typeof ritualMarker>) => { m.targeted[3].id = ''; }, 'non-empty'],
    ['four scenarios instead of five', (m: ReturnType<typeof ritualMarker>) => { m.targeted.pop(); }, 'needs exactly 5'],
    ['six scenarios instead of five', (m: ReturnType<typeof ritualMarker>) => {
      m.targeted.push({ id: 'targeted-probe-06', attempts: 3, passCount: 3, allGreen: true, gitSha: HEAD });
    }, 'needs exactly 5'],
    ['five copies of one scenario', (m: ReturnType<typeof ritualMarker>) => {
      m.targeted = m.targeted.map((r) => ({ ...r, id: 'targeted-probe-01' }));
    }, 'distinct'],
    ['one scenario records no head', (m: ReturnType<typeof ritualMarker>) => { m.targeted[4].gitSha = ''; }, 'gitSha missing'],
    // THE ONE-HEAD RULE, v1's "a fix landed between the two proofs", generalised to five.
    ['a fix landed between two of the five', (m: ReturnType<typeof ritualMarker>) => { m.targeted[2].gitSha = OTHER; }, 'not the same commit'],
    // ...and "no fix landed SINCE", which stays a release-time comparison against the real HEAD.
    ['the ritual proved a different tree', (m: ReturnType<typeof ritualMarker>) => { m.dojoHead = OTHER; m.gitSha = OTHER; }, 'not the tree being shipped'],
    ['a fix landed after the ritual', (m: ReturnType<typeof ritualMarker>) => { m.fixesAfterFinalDraw = true; }, 'fixesAfterFinalDraw'],
    ['the marker does not say which cut the five probed', (m: ReturnType<typeof ritualMarker>) => { m.targetedVersion = '  '; }, 'targetedVersion'],
    ['a pre-redesign kit wrote the marker (no ritualVersion)', (m: Record<string, unknown>) => { delete m.ritualVersion; }, 'ritualVersion'],
    ['the marker claims a ritual version this gate does not implement', (m: ReturnType<typeof ritualMarker>) => { m.ritualVersion = 3; }, 'literal 2'],
  ])('RED: %s', (_label, mutate, expected) => {
    const marker = ritualMarker();
    mutate(marker as never);
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

  it('PARITY of the id shape: both sides count NON-EMPTY, DISTINCT ids, not entries', () => {
    // L3-F5a's lesson, carried over: the two sides once differed on whether an empty string
    // counted (`pinnedDraws: ['']` refused in one copy and shipped in the other). Safe direction,
    // not equivalent. The v2 equivalent is the five-ids check, so both copies must filter.
    const copy = extractRitualCheck('/nonexistent.json');
    expect(copy, 'the copy no longer filters the targeted ids to non-empty strings')
      .toMatch(/named[\s\S]{0,200}filter/);
    const kit = kitValidatorSource();
    if (kit !== null) expect(kitValidatorBody(kit)).toMatch(/named[\s\S]{0,200}filter/);
    // And both must agree on the SAME five-different-things rule, measured rather than read.
    const marker = ritualMarker();
    marker.targeted = marker.targeted.map((r) => ({ ...r, id: 'targeted-probe-01' }));
    expect(verdictFor(marker), 'five copies of one scenario id is one proof recorded five times')
      .not.toBe('');
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

  it('the ✓ line reports the fields the gate CHECKED, not a separate stored count', () => {
    // L3-F6: a v1 marker with `n: 3` and ten families made the success line announce "3 families"
    // about a draw the gate had just accepted as ten. The rule the finding set stands: the ✓ line
    // may only read what a clause above validated.
    const sh = fs.readFileSync(RELEASE_SH, 'utf-8');
    const echoLine = sh.split('\n').find((l) => l.includes('release ritual proven')) ?? '';
    expect(echoLine).not.toBe('');
    expect(echoLine, 'the ✓ line should report targeted.length, the field the gate counted')
      .toMatch(/targeted\|\|\s?\[\]/);
    expect(echoLine, 'the ✓ line should report the per-scenario ratio the gate validated')
      .toMatch(/passCount/);
  });
});
