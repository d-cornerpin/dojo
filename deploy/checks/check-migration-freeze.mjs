#!/usr/bin/env node
// ════════════════════════════════════════
// THE MIGRATION FREEZE — an applied migration may not change without an adjudication.
//
// ── THE INCIDENT THIS MECHANISES (2026-09-26) ──
// The names/PII scrub edited COMMENT lines in three migrations that users' boxes had already applied
// — `135_work_spine.sql`, `159_owed_interrupt_event_kind.sql`, `171_report_read_indexes.sql`. The edits
// were legitimate: migrations are RAW-COPIED into the package (`deploy/build-package.sh:57-58`), so a
// dev-box agent name inside one genuinely ships to every user's disk, and the owner's rule forbids
// that. But `_migrations.checksum` records what was APPLIED, so every boot of every box that ran those
// files then logged `MIGRATION DIVERGENCE` at ERROR — for ever, on a cosmetic change.
//
// The repair is `KNOWN_DIVERGENCES` in `packages/server/src/db/migration-checksums.ts`: an entry whose
// (file, appliedChecksum, fileChecksum) triple matches turns the ERROR into an examined INFO. And the
// reason that repair needs a GATE rather than a convention is in the mechanism itself: an entry
// CANNOT pre-approve a future edit. Amend the file again and the triple stops matching and the ERROR
// comes straight back — silently, because nobody re-reads a boot log they have learned to ignore.
// "Comment-frozen once applied" as a habit will not hold, because the same legitimate reason (a name,
// a wrong word, a stale pointer in raw-copied SQL) will recur.
//
// ── WHAT IT ASSERTS, AND WHY THAT IS CHECKABLE RATHER THAN HISTORICAL ──
// The baseline is the LATEST RELEASE TAG, because a file that shipped in a release is a file some box
// has applied. For every migration present at that tag:
//
//     bytes unchanged  ->  nothing to adjudicate
//     bytes CHANGED    ->  KNOWN_DIVERGENCES must hold an entry for that filename whose
//                          `appliedChecksum` is the TAG's checksum and whose `fileChecksum` is the
//                          CURRENT one. Anything else — no entry, a stale entry, an entry that
//                          adjudicates some other pair of versions — fails.
//     file REMOVED     -> fails loudly: that is the `superseded` class and it needs a human, not a
//                          checksum (a box will report a recorded name whose file is gone).
//
// It also runs in `--staged` mode for a pre-commit hook: any staged change under
// `db/migrations/**` demands that the same staged set touch `migration-checksums.ts`.
//
// ⚠ THE HASH AND THE LEDGER ARE BOTH READ FROM THE PRODUCT, AND THE HASH IS PINNED.
// A plain-node gate cannot import the TypeScript module (its specifiers are `.js` and there is no
// build at pre-build time), so this file computes the checksum itself — sha256 over the text with CRLF
// normalised — and then PINS the product's implementation by reading its source and refusing if it is
// no longer that. A gate that re-typed the logic and drifted would report green while every boot
// errored, which is the whole failure mode here. The ledger entries are parsed out of the same file,
// so there is no second copy of the adjudications either.
//
// Usage:  node deploy/checks/check-migration-freeze.mjs [--staged] [--verbose]
// ════════════════════════════════════════
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const DIR = 'packages/server/src/db/migrations';
const VERBOSE = process.argv.includes('--verbose');
const STAGED = process.argv.includes('--staged');

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const CHECKSUM_MODULE = 'packages/server/src/db/migration-checksums.ts';
const moduleSource = fs.readFileSync(path.join(ROOT, CHECKSUM_MODULE), 'utf8');

/**
 * The product's own hash, PINNED. If `migrationChecksum` stops being "sha256 of the text with CRLF
 * normalised", this gate is computing a different number from the boot and must say so rather than
 * compare apples to oranges.
 */
const PINNED_IMPL = "crypto.createHash('sha256').update(sqlText.replace(/\\r\\n/g, '\\n'), 'utf-8').digest('hex')";
if (!moduleSource.includes(PINNED_IMPL)) {
  console.error(`✗ migration freeze: \`migrationChecksum\` in ${CHECKSUM_MODULE} is no longer the`);
  console.error('  implementation this gate pins, so the numbers it computes would no longer be the');
  console.error('  numbers the boot compares. Update the pin here in the same commit as that change.');
  console.error(`  pinned: ${PINNED_IMPL}`);
  process.exit(1);
}
const migrationChecksum = (sqlText) =>
  crypto.createHash('sha256').update(sqlText.replace(/\r\n/g, '\n'), 'utf-8').digest('hex');

/** The adjudications, parsed out of the product module — never a second copy. */
function knownDivergences() {
  const body = moduleSource.slice(moduleSource.indexOf('export const KNOWN_DIVERGENCES'));
  const out = [];
  for (const m of body.matchAll(/\{\s*file:\s*'([^']+)',\s*appliedChecksum:\s*'([0-9a-f]{64})',\s*fileChecksum:\s*'([0-9a-f]{64})',\s*since:\s*'([^']*)'/g)) {
    out.push({ file: m[1], appliedChecksum: m[2], fileChecksum: m[3], since: m[4] });
  }
  if (out.length === 0) {
    console.error('✗ migration freeze: parsed ZERO adjudications out of the product module. The shape '
      + 'of KNOWN_DIVERGENCES changed and this reader went blind — which would pass every unadjudicated '
      + 'edit. Fix the reader, do not delete the clause.');
    process.exit(1);
  }
  return out;
}
const KNOWN_DIVERGENCES = knownDivergences();

// ── --staged: the pre-commit form. A migration edit and its adjudication ride together. ──
if (STAGED) {
  const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  const migrations = staged.filter((f) => f.startsWith(`${DIR}/`));
  if (migrations.length === 0) {
    console.log('✓ migration freeze: no staged migration change');
    process.exit(0);
  }
  const adjudicated = staged.some((f) => f.endsWith('db/migration-checksums.ts'));
  if (adjudicated) {
    console.log(`✓ migration freeze: ${migrations.length} staged migration change(s), and `
      + 'migration-checksums.ts is in the same commit');
    process.exit(0);
  }
  console.error(`✗ migration freeze: ${migrations.length} staged change(s) under ${DIR}/ with no `
    + 'adjudication in the same commit:');
  for (const m of migrations) console.error(`    ${m}`);
  console.error('\n  An applied migration that changes without a KNOWN_DIVERGENCES entry makes every');
  console.error('  box that ran it log MIGRATION DIVERGENCE at ERROR on every boot, for ever. Add the');
  console.error('  entry to packages/server/src/db/migration-checksums.ts in THIS commit, or make the');
  console.error('  change a NEW numbered migration instead of an amendment.');
  process.exit(1);
}

// ── the default form: the invariant, over every version a box could have APPLIED ──
//
// ⚠ TWO EARLIER CUTS OF THIS BASELINE WERE WRONG, AND BOTH FAILURES ARE INSTRUCTIVE.
//
//  1. THE TAG ALONE had a hole the size of this incident: `171_report_read_indexes.sql` was added
//     AFTER v3.2.0, so it is not in the tag's tree and a tag baseline never compared it — while the
//     dev box had already applied it and was logging the ERROR every boot. A migration does not have
//     to ship in a release to have been applied; it only has to exist in a commit somebody runs.
//  2. EVERY HISTORICAL VERSION was too wide the other way: it flagged eight files whose only "old"
//     versions are development-time iteration from months before their first release. Nobody ever
//     applied those bytes, and a gate that demands a ledger entry for them teaches people to write
//     ledger entries that mean nothing.
//
// So a version counts as APPLICABLE when it could have reached a database:
//   · its commit is contained in a RELEASE TAG (`git tag --contains`) — it shipped, so a user's box
//     may hold exactly that checksum; or
//   · its commit is on this branch SINCE the last tag — the dev box runs the branch, which is how
//     `171` came to diverge.
// Everything else is printed as development-time iteration and is not a finding.
//
// It is cheap because it asks the question in the right order: a file with ONE version in its whole
// history cannot diverge and is skipped without touching a tag at all, which is 163 of the 175 files
// here. Only the handful with multiple versions pay for a `git tag --contains` per version.
let tag = null;
try {
  tag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*']).trim();
} catch { /* an untagged clone still checks the post-tag population, which is then everything */ }

const sinceTag = new Set(
  tag ? git(['log', '--format=%H', `${tag}..HEAD`]).split('\n').filter(Boolean) : [],
);
const showAt = (rev, rel) => {
  try {
    return execFileSync('git', ['show', `${rev}:${rel}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }            // the file did not exist at that rev
};
// ⚠ THIS FUNCTION'S FIRST CUT WAS A FALSE-GREEN GENERATOR, and it is worth the paragraph. It ran
// `git tag --contains <rev> --match 'v*'` — an invalid option ORDER for this git, which errors — and
// swallowed the failure into `catch { out = '' }`, i.e. into "this version never shipped". Every
// released version therefore classified as development-time iteration and the gate reported a clean
// tree while `135` and `159` were provably in v3.2.0. A gate that cannot ask git a question must
// REFUSE, never assume the reassuring answer.
const releasedCache = new Map();
const isReleased = (rev) => {
  if (!releasedCache.has(rev)) {
    let out;
    try {
      out = execFileSync('git', ['tag', '-l', 'v*', '--contains', rev],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      console.error('✗ migration freeze: `git tag -l --contains` failed, so this gate cannot tell a '
        + 'released version from development iteration. It refuses rather than guessing the '
        + `reassuring answer: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    releasedCache.set(rev, out.split('\n').filter(Boolean)[0] ?? null);
  }
  return releasedCache.get(rev);
};

const ledger = new Map();
for (const k of KNOWN_DIVERGENCES) {
  if (!ledger.has(k.file)) ledger.set(k.file, []);
  ledger.get(k.file).push(k);
}

const unadjudicated = [];
const adjudicated = [];
const preRelease = [];
const debt = [];
let single = 0;

for (const name of fs.readdirSync(path.join(ROOT, DIR)).filter((f) => f.endsWith('.sql')).sort()) {
  const rel = `${DIR}/${name}`;
  const nowSum = migrationChecksum(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
  const revs = git(['log', '--format=%H', '--follow', '--', rel]).split('\n').filter(Boolean);
  // The cheap skip, and it is written carefully because its first cut was a hole exactly the size of
  // this gate's purpose: `versions.size <= 1` alone skipped any file with ONE COMMITTED version —
  // including a file whose WORKING TREE differs from it, which is precisely "somebody just amended an
  // applied migration". Caught by this gate's own plant proof (a comment added to `172`, which was
  // committed once after the tag, sailed through). The skip now requires that the one version IS the
  // current bytes.
  const versions = new Map();                       // checksum -> newest rev that produced it
  for (const rev of revs) {
    const text = showAt(rev, rel);
    if (text === null) continue;
    const sum = migrationChecksum(text);
    if (!versions.has(sum)) versions.set(sum, rev);
  }
  if (versions.size === 1 && versions.has(nowSum)) { single++; continue; }
  if (versions.size === 0) { single++; continue; }        // never committed: a brand-new migration

  // WHICH TIER, and the discriminator is WHEN THE OLD VERSION STOPPED BEING CURRENT — not how
  // recently the file was touched. The freeze binds the edit you just made: if the LAST RELEASE
  // shipped bytes `v` and the tree now says something else, that is this gate's business. If `v` had
  // already been superseded by the time the tag shipped, the divergence was created by somebody
  // else's earlier amendment and is historical debt — printed in full every run, the same shape the
  // orphan gate uses for its declared debt, and not this gate's to fail a build over.
  //
  // Measured consequence, and it is why the rule is written this way: `135_work_spine.sql` has THREE
  // historical versions. v3.2.0 shipped the middle one, my scrub made the third — mine, adjudicated.
  // The first was superseded in July by a clamp hotfix that amended an applied migration, which is a
  // real divergence with a real behavioural delta and somebody else's warrant to write. Tiering by
  // "was the file edited since the tag" put that July pair in MY tier and demanded I adjudicate a
  // change I did not make and cannot honestly describe.
  const tagText = tag ? showAt(tag, rel) : null;
  const tagSum = tagText === null ? null : migrationChecksum(tagText);
  for (const [sum, rev] of versions) {
    if (sum === nowSum) continue;
    const releasedIn = isReleased(rev);
    const applicable = releasedIn !== null || sinceTag.has(rev);
    if (!applicable) { preRelease.push({ name, rev: rev.slice(0, 8) }); continue; }
    const entry = (ledger.get(name) ?? []).find((k) => k.appliedChecksum === sum && k.fileChecksum === nowSum);
    const where = releasedIn ? `released in ${releasedIn}` : `on this branch since ${tag}`;
    const row = { name, rev: rev.slice(0, 8), where, oldSum: sum, nowSum, near: (ledger.get(name) ?? []).length };
    // `v` is the freeze's business when the last release shipped exactly `v` (so the tree changed it),
    // or when the file is newer than the tag and `v` came from this branch (171's class).
    const bindsNow = tagSum === null ? sinceTag.has(rev) : sum === tagSum;
    if (entry) adjudicated.push({ ...row, entry });
    else if (bindsNow) unadjudicated.push(row);
    else debt.push(row);
  }
}

// A recorded name whose file is gone is the `superseded` class: it needs a human, not a checksum.
const removed = [];
if (tag) {
  for (const rel of git(['ls-tree', '-r', '--name-only', tag, '--', DIR]).split('\n').filter(Boolean)) {
    if (!fs.existsSync(path.join(ROOT, rel))) removed.push(path.basename(rel));
  }
}

console.log('── migration freeze ──');
console.log(`  ${single} migration(s) with one version in their whole history (cannot diverge)`);
console.log(`  ${adjudicated.length} applicable change(s) WITH a matching adjudication, `
  + `${unadjudicated.length} without, ${removed.length} removed since ${tag ?? 'the tag'}`);
if (debt.length > 0) {
  console.log(`  ⚠ ${debt.length} HISTORICAL divergence(s) — a released version differs from the file, `
    + 'and it had ALREADY been superseded by the time the last tag shipped, so the divergence was '
    + 'created by an earlier amendment rather than by the current tree. Pre-existing debt, printed in '
    + 'full every run, not this gate\'s to fail a build over:');
  for (const d of debt) console.log(`     ${d.name}  applied ${d.oldSum.slice(0, 12)}… (${d.where}) vs now ${d.nowSum.slice(0, 12)}…`);
}
if (preRelease.length > 0) {
  console.log(`  ${preRelease.length} development-time version(s) that never reached a tag or this `
    + 'branch — not findings: ' + [...new Set(preRelease.map((p) => p.name))].join(', '));
}
if (VERBOSE) for (const a of adjudicated) console.log(`     adjudicated: ${a.name} (was ${a.rev}, ${a.where}, since ${a.entry.since})`);

if (unadjudicated.length === 0 && removed.length === 0) {
  console.log('✓ migration freeze: every applied migration that changed carries a matching adjudication');
  process.exit(0);
}
for (const u of unadjudicated) {
  console.error(`✗ ${u.name} differs from the version at ${u.rev} (${u.where}), with no matching KNOWN_DIVERGENCES entry`);
  console.error(`    applied: ${u.oldSum}`);
  console.error(`    now:     ${u.nowSum}`);
  if (u.near > 0) console.error(`    (${u.near} entr(y/ies) exist for this file but adjudicate other versions — a stale entry is not an adjudication)`);
}
for (const r of removed) {
  console.error(`✗ ${r} shipped at ${tag} and is GONE from the tree — the \`superseded\` class.`);
  console.error('    A box carrying that name will report a recorded migration whose file is absent.');
}
console.error('\n  Every box that applied the old bytes logs MIGRATION DIVERGENCE at ERROR on every');
console.error('  boot until the triple matches. Add the entry (file, appliedChecksum, fileChecksum,');
console.error('  since, reason) to packages/server/src/db/migration-checksums.ts — or revert the');
console.error('  migration and put the change in a NEW numbered file.');
process.exit(1);
