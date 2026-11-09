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
  targeted: Array.from({ length: 2 }, (_, i) => ({
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
    ['one of the two was not all green', (m: ReturnType<typeof ritualMarker>) => { m.targeted[0].allGreen = false; }, 'allGreen'],
    ['one scenario ran only two attempts', (m: ReturnType<typeof ritualMarker>) => { m.targeted[1].attempts = 2; }, 'needs exactly 3'],
    ['one scenario passed two of its three attempts', (m: ReturnType<typeof ritualMarker>) => { m.targeted[0].passCount = 2; }, 'unanimity'],
    ['one scenario is not identified', (m: ReturnType<typeof ritualMarker>) => { m.targeted[1].id = ''; }, 'non-empty'],
    ['one scenario instead of two', (m: ReturnType<typeof ritualMarker>) => { m.targeted.pop(); }, 'needs exactly 2'],
    ['three scenarios instead of two', (m: ReturnType<typeof ritualMarker>) => {
      m.targeted.push({ id: 'targeted-probe-03', attempts: 3, passCount: 3, allGreen: true, gitSha: HEAD });
    }, 'needs exactly 2'],
    ['five scenarios, the count retired on 2026-11-06', (m: ReturnType<typeof ritualMarker>) => {
      for (const n of [3, 4, 5]) m.targeted.push({ id: `targeted-probe-0${n}`, attempts: 3, passCount: 3, allGreen: true, gitSha: HEAD });
    }, 'needs exactly 2'],
    ['two copies of one scenario', (m: ReturnType<typeof ritualMarker>) => {
      m.targeted = m.targeted.map((r) => ({ ...r, id: 'targeted-probe-01' }));
    }, 'distinct'],
    ['one scenario records no head', (m: ReturnType<typeof ritualMarker>) => { m.targeted[1].gitSha = ''; }, 'gitSha missing'],
    // THE ONE-HEAD RULE, v1's "a fix landed between the two proofs", generalised.
    ['a fix landed between the two', (m: ReturnType<typeof ritualMarker>) => { m.targeted[1].gitSha = OTHER; }, 'not the same commit'],
    // "No product change SINCE" is the release-time rule marker_matches_tree, proven against real git at the end of this file.
    ['a fix landed after the ritual', (m: ReturnType<typeof ritualMarker>) => { m.fixesAfterFinalDraw = true; }, 'fixesAfterFinalDraw'],
    ['the marker does not say which cut the two probed', (m: ReturnType<typeof ritualMarker>) => { m.targetedVersion = '  '; }, 'targetedVersion'],
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

describe('the copy and the original check the same fields', () => {
  it('release.sh names every ritual field (frozen list — cannot pass vacuously if the kit is absent)', () => {
    const block = extractRitualCheck('/nonexistent.json');
    for (const field of RITUAL_FIELDS) {
      expect(block, `the ritual check no longer mentions ${field}`).toContain(field);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE PAID MARKER COVERS THIS TREE (owner ruling 2026-11-06). release.sh no longer demands the
// marker's sha EQUAL HEAD. It demands the sha be an ANCESTOR of HEAD and that no product code
// (packages, watchdog, templates, menubar) changed between them. That rule is one shell function,
// `marker_matches_tree`, and these clauses run its own bytes against real throwaway git repositories.
// They replace the old 'the ritual proved a different tree' clause, which tested the retired
// sha-equality compare.
// ════════════════════════════════════════════════════════════════════════════════════════

function extractMarkerMatchesTree(): string {
  const sh = fs.readFileSync(RELEASE_SH, 'utf-8');
  const m = /^marker_matches_tree\(\) \{\n[\s\S]*?\n\}\n/m.exec(sh);
  if (!m) throw new Error('no marker_matches_tree() { ... } function in deploy/release.sh');
  return m[0];
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: GIT_ENV }).trim();

function commitFile(repo: string, rel: string, body: string, msg: string): string {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
  git(repo, 'add', '--', rel);
  git(repo, 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

function scratchRepo(): string {
  const repo = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'marker-tree-'));
  git(repo, 'init', '-q');
  return repo;
}

/** What release.sh's own function says about `sha` at the repo's HEAD. */
function treeVerdict(repo: string, sha: string): { ok: boolean; out: string } {
  const script = `${extractMarkerMatchesTree()}\nmarker_matches_tree "$1"\n`;
  try {
    const out = execFileSync('bash', ['-c', script, 'marker-rule', sha], {
      cwd: repo, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('the paid marker covers this tree: an ancestor of HEAD with no product code changed since (real git)', () => {

  it('ACCEPTS an ancestor marker when only gate-side and doc files changed after it', () => {
    const repo = scratchRepo();
    try {
      const marker = commitFile(repo, 'packages/server/src/feature.ts', 'export const v = 1;\n', 'product at the paid run');
      commitFile(repo, 'deploy/checks/check-fixture.mjs', '// gate side\n', 'gate-side change after the paid run');
      commitFile(repo, 'docs/notes.md', 'notes\n', 'doc change after the paid run');
      const accepted = treeVerdict(repo, marker);
      expect(accepted.ok, `an ancestor with no product diff must be accepted: ${accepted.out}`).toBe(true);
      expect(treeVerdict(repo, git(repo, 'rev-parse', 'HEAD')).ok, 'a marker at HEAD itself is accepted').toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([
    'packages/server/src/feature.ts', 'watchdog/w.ts', 'templates/SOUL.md', 'menubar/m.swift',
  ])('REFUSES once product code changed after the paid run (%s), naming the file', (rel) => {
    const repo = scratchRepo();
    try {
      const marker = commitFile(repo, 'packages/server/src/feature.ts', 'export const v = 1;\n', 'product at the paid run');
      commitFile(repo, rel, 'changed after the paid run\n', `product change in ${rel}`);
      const refused = treeVerdict(repo, marker);
      expect(refused.ok, `a change to ${rel} after the paid run must be refused`).toBe(false);
      expect(refused.out).toContain('product code changed since the paid run');
      expect(refused.out, 'the refusal names the file that differs').toContain(rel);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('REFUSES a marker sha that is not an ancestor of HEAD, even with no product diff', () => {
    const repo = scratchRepo();
    try {
      const marker = commitFile(repo, 'packages/server/src/feature.ts', 'export const v = 1;\n', 'product at the paid run');
      const side = git(repo, 'commit-tree', `${marker}^{tree}`, '-m', 'a tree HEAD does not descend from');
      const refused = treeVerdict(repo, side);
      expect(refused.ok, 'a non-ancestor must be refused').toBe(false);
      expect(refused.out).toContain('is not an ancestor of HEAD');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
