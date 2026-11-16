#!/usr/bin/env node
// ════════════════════════════════════════
// THE MIGRATION FREEZE: a migration a release shipped never changes.
//
// Migrations are raw-copied into the package and `_migrations.checksum` records the bytes a box
// applied; a box whose file later differs warns at every boot and never re-runs it. So the bytes a
// release tag shipped may not be edited: a change goes in a NEW numbered file. A file in no release
// tag has reached no user's box and may still change. The checksum is the runner's own (sha256 of
// the text with CRLF normalised, `db/migrations.ts`).
//
// It also holds the ORDER: a file new since the last release tag sorts after every file that tag
// holds, so a fresh install and an updated box apply the steps in the same order.
//
// Usage:  node deploy/checks/check-migration-freeze.mjs
// ════════════════════════════════════════
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const DIR = 'packages/server/src/db/migrations';

// Written before the order rule. A name the last release tag holds must be deleted from this list.
const WRITTEN_BEFORE_ORDER_RULE = [
  '210_finished_rows_answer_their_verdict_request.sql', '211_work_ledger_detail.sql', '212_no_summary_writer_setting.sql',
  '213_background_commands.sql', '214_background_command_call.sql', '215_imaginer_stays_retired.sql',
  '216_router_probe_settings_removed.sql', '217_one_owner_name_key.sql', '218_conversation_tail_index.sql',
];

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const migrationChecksum = (sqlText) =>
  crypto.createHash('sha256').update(sqlText.replace(/\r\n/g, '\n'), 'utf-8').digest('hex');

// A version counts only when its commit is in a release tag; a file with one version in its whole
// history, equal to the tree, cannot diverge and is skipped without asking git about tags.
let tag = null;
try {
  tag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*']).trim();
} catch { /* an untagged clone has shipped nothing, so nothing is frozen */ }

const showAt = (rev, rel) => {
  try {
    return execFileSync('git', ['show', `${rev}:${rel}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }            // the file did not exist at that rev
};
// A gate that cannot ask git which tags hold a version refuses rather than assume it never shipped.
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
// True when `rev` is in the described tag's history; git exits 1 for "no" and refuses on anything else.
const inTagHistory = (rev) => {
  try { git(['merge-base', '--is-ancestor', rev, tag]); return true; } catch (err) {
    if (err?.status === 1) return false;
    console.error(`✗ migration freeze: \`git merge-base --is-ancestor\` failed, so it refuses: ${err?.message ?? err}`);
    process.exit(1);
  }
};

const files = fs.readdirSync(path.join(ROOT, DIR)).filter((f) => f.endsWith('.sql')).sort();
const inTag = tag ? git(['ls-tree', '--name-only', tag, '--', `${DIR}/`]).split('\n').filter(Boolean).map((p) => path.basename(p)) : [];
const lastInTag = [...inTag].sort().at(-1);
const outOfOrder = files.filter((f) => lastInTag && f < lastInTag && !inTag.includes(f) && !WRITTEN_BEFORE_ORDER_RULE.includes(f));
const listedButReleased = WRITTEN_BEFORE_ORDER_RULE.filter((f) => inTag.includes(f));

const changed = [];
const preRelease = [];
const debt = [];
let single = 0;

for (const name of files) {
  const rel = `${DIR}/${name}`;
  const nowSum = migrationChecksum(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
  const revs = git(['log', '--format=%H', '--follow', '--', rel]).split('\n').filter(Boolean);
  const versions = new Map();                       // checksum -> every rev that produced it, newest first
  for (const rev of revs) {
    const text = showAt(rev, rel);
    if (text === null) continue;
    const sum = migrationChecksum(text);
    versions.set(sum, [...(versions.get(sum) ?? []), rev]);
  }
  if (versions.size === 1 && versions.has(nowSum)) { single++; continue; }
  if (versions.size === 0) { single++; continue; }        // never committed: a brand-new migration

  // Every released version that differs from the tree fails, except one the described tag itself
  // superseded (every released commit of it in the tag's history, other bytes at the tag): older
  // debt, printed but not failed. A commit in the tag's history shipped in it.
  const tagText = tag ? showAt(tag, rel) : null;
  const tagSum = tagText === null ? null : migrationChecksum(tagText);
  for (const [sum, sumRevs] of versions) {
    if (sum === nowSum) continue;
    let rev = null;
    let outsideTag = false;
    for (const r of sumRevs) {
      const inTag = tag !== null && inTagHistory(r);
      if (!inTag && isReleased(r) === null) continue;
      rev = r;
      outsideTag ||= !inTag;
    }
    if (rev === null) { preRelease.push({ name, rev: sumRevs[0].slice(0, 8) }); continue; }
    const row = { name, rev: rev.slice(0, 8), where: `released in ${isReleased(rev)}`, oldSum: sum, nowSum };
    if (tagSum !== null && sum !== tagSum && !outsideTag) debt.push(row);
    else changed.push(row);
  }
}

// A file any release tag shipped and the tree no longer has is the `superseded` class: it needs a human.
const gone = [...new Set(git(['log', '--no-renames', '--diff-filter=D', '--name-only', '--format=', '--', DIR]).split('\n'))]
  .filter((rel) => rel && !fs.existsSync(path.join(ROOT, rel)));
const tags = gone.length ? git(['tag', '-l', 'v*']).split('\n').filter(Boolean) : [];
const asks = tags.flatMap((t) => gone.map((rel) => ({ t, rel })));
const held = asks.length ? execFileSync('git', ['cat-file', '--batch-check'], { cwd: ROOT, encoding: 'utf8', input: asks.map((a) => `${a.t}:${a.rel}`).join('\n') + '\n' }).split('\n') : [];
const removed = [...new Map(asks.filter((_, i) => !held[i].endsWith('missing')).map((a) => [a.rel, { name: path.basename(a.rel), tag: a.t }])).values()];

console.log('── migration freeze ──');
console.log(`  ${single} migration(s) with one version in their whole history (cannot diverge)`);
console.log(`  ${changed.length} released migration(s) changed, ${removed.length} removed since ${tag ?? 'the tag'}`);
if (debt.length > 0) {
  console.log(`  ⚠ ${debt.length} HISTORICAL divergence(s) — a released version differs from the file, `
    + `and ${tag} had ALREADY superseded it with other bytes, so the divergence was `
    + 'created by an earlier amendment rather than by the current tree. Pre-existing debt, printed in '
    + 'full every run, not this gate\'s to fail a build over:');
  for (const d of debt) console.log(`     ${d.name}  applied ${d.oldSum.slice(0, 12)}… (${d.where}) vs now ${d.nowSum.slice(0, 12)}…`);
}
if (preRelease.length > 0) {
  console.log(`  ${preRelease.length} version(s) in no release tag, free to change: ` + [...new Set(preRelease.map((p) => p.name))].join(', '));
}
if (changed.length === 0 && removed.length === 0 && outOfOrder.length === 0 && listedButReleased.length === 0) {
  console.log('✓ migration freeze: no migration a release shipped has changed, and every new one sorts after them');
  process.exit(0);
}
for (const u of changed) {
  console.error(`✗ ${u.name} differs from the version at ${u.rev} (${u.where})`);
  console.error(`    applied: ${u.oldSum}`);
  console.error(`    now:     ${u.nowSum}`);
}
for (const r of removed) {
  console.error(`✗ ${r.name} shipped at ${r.tag} and is GONE from the tree, the \`superseded\` class.`);
  console.error('    A box carrying that name will report a recorded migration whose file is absent.');
}
for (const f of outOfOrder) {
  console.error(`✗ ${f} is new since ${tag} and sorts before ${lastInTag}, which ${tag} holds: a fresh install would apply`);
  console.error('    it before that step and an updated box after it. Number it after every released file.');
}
for (const f of listedButReleased) {
  console.error(`✗ ${f} is in ${tag} now, so it no longer needs the exemption: delete it from WRITTEN_BEFORE_ORDER_RULE.`);
}
if (changed.length || removed.length) {
  console.error('\n  A box that applied the old bytes keeps them and warns at every boot. Revert the');
  console.error('  migration and put the change in a NEW numbered file.');
}
process.exit(1);
