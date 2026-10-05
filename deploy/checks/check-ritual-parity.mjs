#!/usr/bin/env node
// ════════════════════════════════════════
// THE RITUAL-MARKER VALIDATOR EXISTS TWICE. THIS IS WHAT BINDS THE COPIES.
//
// ── THE DEFECT, MEASURED (backlog 2026-09-26, lane 3 concern 4) ──
// The owner's 2026-09-20 ruling — every cut proves a 3-attempt blast AND a fresh
// ten-family draw, both at the same platform commit — is enforced by TWO
// validators that are deliberately separate copies:
//
//   · the kit's `behavioral/lib/release-ritual.mjs` `validateReleaseRitualMarker`,
//     which refuses at WRITE time, before the runner will overwrite last-green.json;
//   · `deploy/release.sh`'s own field checks, which refuse at CUT time. The release
//     runs in bash and cannot import ESM across the sibling-repo boundary, exactly
//     as its existing BEHAV_DISHONEST and MODEL_MISMATCH checks cannot.
//
// The duplication is argued and stays. What was missing is the binding: the two
// DRIFTED WITHIN THE HOUR of the second being written. `final.drawUnsteered` plus
// `final.pinnedDraws` landed in the kit and the release copy did not have them, so
// for that window a steered rehearsal draw would have been refused at write and
// accepted at the cut. Nothing failed. A hand-typed count was once the only thing
// binding the two gate lists (see `check-gate-manifest.mjs`); a comment was the
// only thing binding these two.
//
// ── WHAT THIS GATE DOES, AND WHY IT IS NOT A TEXT COMPARE ──
// It EXTRACTS the two node programs out of release.sh, RUNS them, runs the kit's
// validator over the same fixtures, and refuses when the two verdicts disagree.
// A text compare would be hopeless — one copy is bash-embedded ES5 reading a
// `require`d file, the other is an ESM module returning `{ok, reasons}` — and it
// would fail on every legitimate rewording while missing a real behavioural gap.
// The question asked here is the only one that matters: IS THERE A MARKER ONE OF
// THEM SHIPS AND THE OTHER REFUSES?
//
// The corpus is a valid marker plus ONE MUTANT PER CLAUSE. Both directions, per
// the house rule: the valid marker must be ACCEPTED by both (a gate whose corpus
// is all-refusals is satisfied by a validator that refuses everything), and every
// mutant must be REFUSED by both. A clause deleted from either side turns its
// mutant into a disagreement and this gate reds, naming the clause and the side
// that let it through.
//
// ── THE TWO RELEASE-SIDE BLOCKS ARE ONE SURFACE, AND THAT IS release.sh's DESIGN ──
// release.sh splits the marker question in two on purpose and says so: RITUAL_BAD
// checks the ritual SHAPE and the K1 block (BEHAV_DISHONEST) owns `green`,
// `verdicts[].flaked`, the known-failing list and merge provenance — one copy of
// each question, with an ordering contract (K1 stays above). The kit's validator
// asks all of them in one function. So parity is checked against the UNION of the
// two blocks, which is why this gate extracts both; checking RITUAL_BAD alone
// would report a drift for every clause release.sh deliberately keeps in K1.
//
// ── THE ONE CLAUSE THAT IS RELEASE-ONLY, NEUTRALISED ON PURPOSE ──
// RITUAL_BAD additionally compares `dojoHead` against the HEAD being shipped.
// The kit's module header argues that one out explicitly: whether the recorded
// head is still the actual head is a release-time question. So `$HEAD_SHA` is
// substituted with each fixture's OWN `dojoHead`, which makes that clause inert
// and leaves every shape-of-the-marker clause under test. Freshness (BEHAV_AGE_H)
// and the floor-model check are likewise release-time, file-and-clock questions,
// not marker-shape ones, and are out of scope here — stated rather than silently
// skipped.
//
// ── OFFLINE ──
// The kit is a SIBLING repo and is not present on every box. With no kit this
// SKIPS LOUDLY and exits 0, the same shape and the same reasoning as
// `check-shipped-souls.mjs` offline. That cannot hide a drifted validator from a
// real cut: a release with no kit cannot pass its own behavioral-suite gate,
// which reads a marker out of that same repo. `--require-kit` turns the skip into
// a failure for a caller that knows the kit must be there.
//
// Usage:
//   node deploy/checks/check-ritual-parity.mjs [--require-kit] [--verbose]
//   DOJO_TEST_KIT=/path/to/dojo-test-kit  overrides kit discovery
// Exit 0 = the two validators agree on every fixture (or, offline, nothing to ask).
// ════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const REQUIRE_KIT = process.argv.includes('--require-kit');
const VERBOSE = process.argv.includes('--verbose');

let failed = false;
const fail = (...lines) => { failed = true; for (const l of lines) console.error(l); };

// ════════ 0. find the kit ════════
// release.sh resolves it as `$SCRIPT_DIR/../../dojo-test-kit`, which is right from
// the MAIN checkout and wrong from a git worktree (worktrees sit one level deeper).
// Both layouts are tried, so this gate answers the same question in either place.
function findKit() {
  const declared = process.env.DOJO_TEST_KIT;
  const candidates = declared && declared !== ''
    ? [declared]
    : [path.resolve(ROOT, '../dojo-test-kit'), path.resolve(ROOT, '../../dojo-test-kit')];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'behavioral/lib/release-ritual.mjs'))) return c;
  }
  return null;
}

const KIT = findKit();
if (!KIT) {
  const where = process.env.DOJO_TEST_KIT
    ? `DOJO_TEST_KIT=${process.env.DOJO_TEST_KIT}`
    : `${path.resolve(ROOT, '../dojo-test-kit')} or ${path.resolve(ROOT, '../../dojo-test-kit')}`;
  if (REQUIRE_KIT) {
    console.error('✗ ritual-marker parity: --require-kit was passed and no kit was found.');
    console.error(`  Looked for behavioral/lib/release-ritual.mjs under ${where}.`);
    console.error('  A caller that knows the kit must be there has asked a question this gate could not');
    console.error('  answer, and an instrument that cannot run must not report green.');
    process.exit(1);
  }
  console.log('⚠ ritual-marker parity: SKIPPED — no dojo-test-kit beside this checkout.');
  console.log(`  Looked for behavioral/lib/release-ritual.mjs under ${where}.`);
  console.log('  The kit holds one of the two validators, so with no kit there is nothing to compare.');
  console.log('  This cannot hide a drift from a real cut: a release with no kit fails its own');
  console.log('  behavioral-suite gate, which reads the marker out of that same repo.');
  console.log('  Pass --require-kit (or set DOJO_TEST_KIT) to make this a failure instead.');
  process.exit(0);
}

// ════════ 1. extract both release-side programs ════════
const RELEASE_SH_REL = 'deploy/release.sh';
const releaseSh = fs.readFileSync(path.join(ROOT, RELEASE_SH_REL), 'utf8');

/**
 * Pull `NAME=$(node -e "<program>")` out of the script.
 *
 * The programs contain no backslash, no backtick and no double quote (asserted
 * below), so what bash hands node is the literal text with `$VAR` expanded — and
 * the substitution here is therefore faithful rather than an approximation.
 */
function extractBlock(name) {
  const re = new RegExp(String.raw`^${name}=\$\(node -e "\n([\s\S]*?)\n"\)$`, 'm');
  const m = re.exec(releaseSh);
  return m ? m[1] : null;
}

const BLOCKS = [
  { name: 'BEHAV_DISHONEST', what: 'the K1 honesty block (green, verdicts, known-failing, merge provenance)' },
  { name: 'RITUAL_BAD', what: 'the ritual-shape block (mode, blast 3/3, final 10/10, heads, fixesAfterFinalDraw)' },
];
for (const b of BLOCKS) {
  b.src = extractBlock(b.name);
  if (b.src === null) {
    fail(
      `✗ could not find \`${b.name}=$(node -e "…")\` in ${RELEASE_SH_REL}.`,
      `  That block is ${b.what}. Either it was renamed, re-shaped, or removed — and all three`,
      '  mean this gate is now measuring nothing. Re-point the extraction deliberately.',
      '',
    );
    continue;
  }
  // A block that got shorter than its own clause list is not a block any more.
  if (b.src.length < 300) {
    fail(
      `✗ \`${b.name}\` extracted only ${b.src.length} characters — too short to be the clause list.`,
      '  Extraction matched something, which is worse than matching nothing: the fixtures below',
      '  would run against a stub and report parity.',
      '',
    );
  }
  for (const [ch, why] of [['\\', 'a backslash'], ['`', 'a backtick'], ['"', 'a double quote']]) {
    if (b.src.includes(ch)) {
      fail(
        `✗ \`${b.name}\` now contains ${why}, which bash processes before node ever sees it.`,
        '  This gate substitutes the two shell variables and runs the text verbatim, so a shell',
        '  escape would make what runs here differ from what runs in the release. Either keep the',
        '  block free of shell metacharacters or teach this extraction the escaping rule.',
        '',
      );
    }
  }
  // A verdict nobody reads is not a gate. Assert the APPLICATION, not just the text.
  const applied = new RegExp(String.raw`if \[ -n "\$${b.name}" \]; then[\s\S]{0,400}?\n  fail `).test(releaseSh);
  if (!applied) {
    fail(
      `✗ ${RELEASE_SH_REL} computes \`${b.name}\` but no \`if [ -n "$${b.name}" ]; then … fail\` reads it.`,
      '  The block would still extract and still agree with the kit while refusing nothing at all.',
      '',
    );
  }
}

if (failed) {
  console.error('✗ ritual-marker parity: refusing before running any fixture — the instrument is not intact.');
  process.exit(1);
}

// ════════ 2. the fixture corpus ════════
// One valid marker, then one mutant per clause on either side. No names, no PII:
// every identifier here is fictional and generic by construction (G1).
const SHA = '1111111111111111111111111111111111111111';
const OTHER_SHA = '2222222222222222222222222222222222222222';
const FAMILIES = ['family-01', 'family-02', 'family-03', 'family-04', 'family-05',
  'family-06', 'family-07', 'family-08', 'family-09', 'family-10'];

const validMarker = () => ({
  green: true,
  gitSha: SHA,
  dojoHead: SHA,
  mode: 'release-ritual',
  modelId: 'a-pinned-model-id',
  runId: 'fixture-run',
  blast: { scenario: 'blast-scenario-a', attempts: 3, allGreen: true, gitSha: SHA },
  final: {
    seed: '0123456789ab',
    seedFresh: true,
    drawUnsteered: true,
    families: [...FAMILIES],
    n: 10,
    allGreen: true,
  },
  verdicts: {
    'gen-family-01-aaaa-1': { attempts: 1, passCount: 1, flaked: false },
    'gen-family-02-bbbb-1': { attempts: 2, passCount: 2, flaked: false },
  },
  fixesAfterFinalDraw: false,
});

/** Build a mutant by mutating a deep copy of the valid marker. */
const mutant = (clause, mutate) => {
  const m = validMarker();
  mutate(m);
  return { clause, marker: m };
};

const MUTANTS = [
  // ── the ritual shape (release.sh: RITUAL_BAD · kit: validateReleaseRitualMarker) ──
  mutant('mode is not release-ritual', (m) => { m.mode = 'generated'; }),
  mutant('no blast{} at all', (m) => { delete m.blast; }),
  mutant('blast{} is not an object', (m) => { m.blast = 'three green attempts, honest'; }),
  mutant('blast.scenario missing', (m) => { delete m.blast.scenario; }),
  mutant('blast.scenario empty', (m) => { m.blast.scenario = ''; }),
  mutant('blast.attempts is 2, not 3', (m) => { m.blast.attempts = 2; }),
  mutant('blast.attempts is 4, not 3', (m) => { m.blast.attempts = 4; }),
  mutant('blast.allGreen is not true', (m) => { m.blast.allGreen = false; }),
  mutant('blast.gitSha missing', (m) => { delete m.blast.gitSha; }),
  mutant('no final{} at all', (m) => { delete m.final; }),
  mutant('final.seed missing', (m) => { delete m.final.seed; }),
  mutant('final.families has 9', (m) => { m.final.families = FAMILIES.slice(0, 9); }),
  mutant('final.families has 11', (m) => { m.final.families = [...FAMILIES, 'family-11']; }),
  mutant('final.families is ten copies of one name', (m) => { m.final.families = FAMILIES.map(() => 'family-01'); }),
  mutant('final.families is ten empty strings', (m) => { m.final.families = FAMILIES.map(() => ''); }),
  mutant('final.allGreen is not true', (m) => { m.final.allGreen = false; }),
  mutant('final.seedFresh is not true (a --seed replay)', (m) => { m.final.seedFresh = false; }),
  mutant('final.drawUnsteered missing (THE DRIFT THIS GATE EXISTS FOR)', (m) => { delete m.final.drawUnsteered; }),
  mutant('final.drawUnsteered is false (a steered draw)', (m) => {
    m.final.drawUnsteered = false;
    m.final.pinnedDraws = ['family-03:someSlot=someValue'];
  }),
  mutant('final.drawUnsteered true over its own pinnedDraws', (m) => {
    m.final.pinnedDraws = ['family-03:someSlot=someValue'];
  }),
  mutant('dojoHead missing', (m) => { delete m.dojoHead; }),
  mutant('blast ran at a different head than the final draw', (m) => { m.blast.gitSha = OTHER_SHA; }),
  mutant('gitSha disagrees with dojoHead', (m) => { m.gitSha = OTHER_SHA; }),
  mutant('fixesAfterFinalDraw is true', (m) => { m.fixesAfterFinalDraw = true; }),
  mutant('fixesAfterFinalDraw is missing (not the literal false)', (m) => { delete m.fixesAfterFinalDraw; }),
  // ── the honesty clauses (release.sh: K1 · kit: the mirror block) ──
  mutant('green is not true', (m) => { m.green = false; }),
  mutant('no verdicts{} (a pre-hardening marker)', (m) => { delete m.verdicts; }),
  mutant('a scenario flaked and was rescued by its retry', (m) => { m.verdicts['gen-family-01-aaaa-1'].flaked = true; }),
  mutant('a scenario passed 1 of 2 attempts', (m) => { m.verdicts['gen-family-02-bbbb-1'].passCount = 1; }),
  mutant('a scenario carries a known-failing acknowledgment', (m) => { m.verdicts['gen-family-01-aaaa-1'].knownFailing = 'a booked defect'; }),
  mutant('the marker lists known-failing scenarios', (m) => { m.knownFailing = ['gen-family-04-cccc-1']; }),
  mutant('a merged marker with no mergedFrom provenance', (m) => { m.merged = true; }),
];

// Vacuity floor: one mutant per clause is the design, so a corpus that shrank is a
// corpus that stopped covering the clause list. Not a ratchet — the floor is "the
// fixtures emptied themselves".
const MUTANT_FLOOR = 25;
if (MUTANTS.length < MUTANT_FLOOR) {
  fail(
    `✗ the corpus carries ${MUTANTS.length} mutant(s); the floor is ${MUTANT_FLOOR}.`,
    '  A corpus that empties itself reports parity between two validators it never asked anything.',
    '',
  );
}

// ════════ 3. run the release side ════════
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ritual-parity-'));
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* a temp tree is never a reason to fail */ } };
process.on('exit', cleanup);

/**
 * Run both extracted blocks against one marker, exactly as the release does:
 * each prints its reasons joined with ", " on stdout, and non-empty means REFUSE.
 * `$HEAD_SHA` becomes the marker's own dojoHead so the release-only head compare
 * is inert (see the header).
 */
function releaseVerdict(marker, tag) {
  const markerPath = path.join(TMP, `${tag}.json`);
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  const headSha = typeof marker.dojoHead === 'string' && marker.dojoHead ? marker.dojoHead : SHA;
  const reasons = [];
  for (const b of BLOCKS) {
    const program = b.src
      .split('$BEHAV_MARKER').join(markerPath)
      .split('$HEAD_SHA').join(headSha);
    const progPath = path.join(TMP, `${tag}.${b.name}.cjs`);
    fs.writeFileSync(progPath, program);
    let out;
    try {
      out = execFileSync(process.execPath, [progPath], { encoding: 'utf8', cwd: ROOT });
    } catch (err) {
      return { ok: false, reasons: [`${b.name} THREW: ${String(err.message).split('\n')[0]}`], threw: true };
    }
    const text = out.trim();
    if (text) reasons.push(`${b.name}: ${text}`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ════════ 4. run the kit side ════════
const kitModuleRel = 'behavioral/lib/release-ritual.mjs';
let validateReleaseRitualMarker;
try {
  const mod = await import(new URL(`file://${path.join(KIT, kitModuleRel)}`).href);
  validateReleaseRitualMarker = mod.validateReleaseRitualMarker;
} catch (err) {
  fail(
    `✗ could not import ${path.join(KIT, kitModuleRel)}: ${String(err.message).split('\n')[0]}`,
    '  That module holds the write-time half of the validator. With it unreadable this gate has',
    '  one validator and no comparison to make.',
    '',
  );
}
if (typeof validateReleaseRitualMarker !== 'function') {
  fail(
    `✗ ${kitModuleRel} does not export \`validateReleaseRitualMarker\`.`,
    '  Renaming it is fine; leaving this gate pointed at the old name is not — the comparison',
    '  would silently become a no-op.',
    '',
  );
}

if (failed) {
  console.error('✗ ritual-marker parity: refusing before running any fixture — the instrument is not intact.');
  process.exit(1);
}

// ════════ 5. compare ════════
const disagreements = [];
let agreedRefusals = 0;

function compare(tag, clause, marker, expect) {
  const rel = releaseVerdict(marker, tag);
  const kit = validateReleaseRitualMarker(marker);
  const relAccepts = rel.ok === true;
  const kitAccepts = kit.ok === true;

  if (relAccepts !== kitAccepts) {
    disagreements.push({
      clause,
      accepted: relAccepts ? 'deploy/release.sh' : `the kit's ${kitModuleRel}`,
      refused: relAccepts ? `the kit's ${kitModuleRel}` : 'deploy/release.sh',
      reasons: relAccepts ? kit.reasons : rel.reasons,
    });
    return;
  }
  if (expect === 'accept' && !relAccepts) {
    disagreements.push({
      clause,
      accepted: '(neither)',
      refused: 'BOTH',
      reasons: [...rel.reasons, ...kit.reasons],
      bothRefusedTheValidOne: true,
    });
    return;
  }
  if (expect === 'refuse') {
    if (!relAccepts) agreedRefusals++;
    if (VERBOSE) console.log(`     both refuse: ${clause}`);
  }
}

compare('valid', 'A VALID RELEASE-RITUAL MARKER (both must ACCEPT)', validMarker(), 'accept');
MUTANTS.forEach((m, i) => compare(`m${String(i).padStart(2, '0')}`, m.clause, m.marker, 'refuse'));

// ════════ verdict ════════
console.log('Ritual-marker validator parity — deploy/release.sh vs the kit\'s validateReleaseRitualMarker');
console.log('');
console.log(`  kit: ${KIT}`);
console.log(`  release-side blocks extracted and run: ${BLOCKS.map((b) => b.name).join(' + ')}`);
console.log(`  fixtures: 1 valid marker + ${MUTANTS.length} single-clause mutants (floor ${MUTANT_FLOOR})`);
console.log(`  mutants both validators refused: ${agreedRefusals}/${MUTANTS.length}`);
console.log('');
console.log('  Reproduce:  node deploy/checks/check-ritual-parity.mjs --verbose');
console.log('');

if (disagreements.length) {
  const bothRefused = disagreements.filter((d) => d.bothRefusedTheValidOne);
  const drifted = disagreements.filter((d) => !d.bothRefusedTheValidOne);
  if (bothRefused.length) {
    fail(
      '✗ the VALID fixture marker was refused by both validators.',
      '  The corpus proves nothing in that state: a validator that refuses everything would agree',
      '  with another validator that refuses everything on all 32 fixtures. Either a real clause',
      '  tightened and this fixture owes the new field, or one of them is now refusing a shippable',
      '  marker — which would stop every cut. The reasons, verbatim:',
      '',
    );
    for (const r of bothRefused[0].reasons) fail(`    ${r}`);
    fail('');
  }
  if (drifted.length) {
    fail(
      `✗ the two validators DISAGREE on ${drifted.length} marker shape(s) — they have drifted:`,
      '',
    );
    for (const d of drifted) {
      fail(`    clause: ${d.clause}`);
      fail(`      ${d.accepted} ACCEPTS this marker; ${d.refused} refuses it.`);
      for (const r of d.reasons.slice(0, 4)) fail(`        ${d.refused} says: ${r}`);
      fail('');
    }
    fail(
      '  This is exactly the shape the gate exists for: `final.drawUnsteered` + `pinnedDraws`',
      '  landed in the kit and not in release.sh, and for the window in between a steered',
      '  rehearsal draw was refused at write time and accepted at the cut.',
      '  The fix is to add the clause to whichever side is missing it — never to delete it from',
      '  the side that has it, and never to weaken this corpus.',
      '',
    );
  }
}

if (failed) {
  console.error('✗ ritual-marker parity: refusing.');
  process.exit(1);
}

console.log(
  `✓ ritual-marker parity — the two validators agree on all ${MUTANTS.length + 1} fixtures: `
  + `the valid marker accepted by both, ${agreedRefusals} single-clause mutants refused by both`,
);
process.exit(0);
