#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// PROMPT-GATE RECORD READER (PHASE-0 T13 Step 2). RELEASE-BLOCKING.
//
// ── Why this exists ─────────────────────────────────────────────────────
// The kit checks on the REQUIRED roster below read the live server through the dev
// instruments: check-cache-prefix, check-prompt-inventory, check-steer-delivery,
// check-message-prefix, check-prefix-holds-still, check-assembled-context,
// check-reanswer-ghost.
// (The count is not written in this prose. It was typed as "four" and again as
// "five" while the arrays held different numbers — the hand-typed-N drift T8G
// removed from the two gate lists. The REQUIRED array is the count.)
// They cannot run inside a release — the instruments
// PATCH the tree a release ships, and the release has a gate that refuses any
// artifact still carrying them. So a release could never execute them, and
// "the cache-prefix gate stays blocking" was a sentence people remembered
// rather than a thing the build read. A memory is not a gate.
//
// This reads the record those checks write when they are run the normal way
// (`node checks/run-prompt-gates.mjs` in the kit, server up, instruments in)
// and refuses the release over it.
//
// ── The rules, all of which refuse rather than pass ─────────────────────
//  1. No record file            → REFUSE. An absence is never evidence (#15).
//  2. Unparseable / no checks[] → REFUSE.
//  3. platform.sha != HEAD      → REFUSE. The record must describe the tree
//                                 being shipped, not some other one. This is
//                                 the same hard sha match the behavioral gate
//                                 uses (FA-D4) and it is what makes a stale
//                                 record unusable rather than convenient.
//  4. older than the window     → REFUSE (default 24h, --max-age-hours).
//  5. a rostered check missing  → REFUSE. Dropping a gate has to be an edit to
//                                 the roster below, where a human sees it.
//  6. check with NO knownFailing: exit must be 0. Anything else REFUSES.
//     This is the line that makes the cache-prefix gate blocking for real.
//  7. check WITH knownFailing:
//        exit 1  → recorded, allowed through, PRINTED with its owner pointer.
//                  An acknowledged red is not a pass and is never whitelisted;
//                  it rides in the release record wearing its owner's name.
//        exit 0  → REFUSE. The check now passes while still declaring itself
//                  known-failing: the fix landed and the marker did not get
//                  deleted, so a future real regression would be excused. The
//                  kit's own convention says the fixing task deletes the
//                  export; this is that convention, enforced.
//        else    → REFUSE (2 = environment, 3 = broken probe: a probe that
//                  could not run proves nothing about delivery).
//
// ── Usage ───────────────────────────────────────────────────────────────
//   node deploy/checks/check-prompt-gate-record.mjs
//   node deploy/checks/check-prompt-gate-record.mjs --head <sha> --max-age-hours 24
//   node deploy/checks/check-prompt-gate-record.mjs --record <path>
//
// NOT wired into `npm run gates`: gates must run offline, on a dirty tree, with
// no kit and no server, dozens of times a day. This is a release gate.
// ════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const KIT = process.env.DOJO_TEST_KIT ?? path.join(ROOT, '..', 'dojo-test-kit');
const RECORD = arg('--record', path.join(KIT, 'checks', 'results', 'prompt-gates.json'));
const MAX_AGE_H = Number(arg('--max-age-hours', '24'));
const HEAD = arg('--head', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim());

// Mirrored in dojo-test-kit/checks/run-prompt-gates.mjs. Both sides list the
// roster so that dropping a check is an edit in two places, in the open.
// PHASE-3 T2 added 'check-assembled-context' (the assembled MESSAGE ARRAY against
// golden-v0, built by T1). The four checks that stood here all read the CACHED half
// of the prompt — system prompt + tools; research 25 §1.4: "the message array itself
// has no such guard, and it is mutated on every assembly by six different rewriters."
// Roadmap #10 names the assembled-array golden as the second of the two gates binding
// every task that touches prompt assembly; before this it was a file somebody could
// choose to run.
// PHASE-3 STRIP-3 (2026-08-01, RULING P3-R3) added 'check-reanswer-ghost' — 54 delivered
// messages seeded into an empty session, all 54 required back out of the assembled window.
// It encodes dojo `8bc7d7a`'s months-long re-answer ghost, and it was on NEITHER roster:
// it ran only when a human typed its name, its last recorded green was PHASE-1 T11, and it
// had been RED since PHASE-2 T10I while every report of the period cited a 5/5 GREEN roster
// that never contained it. A ruling was then written resting on it as a deterministic guard
// that ran every time — a claim false in both halves. THE RULE THIS EARNS: a check that
// encodes an incident is either on a roster or it is not a guard.
// PHASE-3 T9 (2026-08-01) added 'check-roster-conformance' — the kit-side twin of
// `check-gate-manifest.mjs`'s rule 1, and the answer to the question STRIP-3 ended on:
// what stops the NEXT check going dark? The deploy side has refused an undeclared
// `deploy/checks/*.mjs` since T8G, but a `deploy/` gate cannot reach into the kit repo,
// so the kit's own `checks/` directory had no such rule — which is precisely how
// `check-reanswer-ghost.mjs` sat on no roster for a phase. The new check refuses a
// `checks/check-*.mjs` file that neither the roster nor a REASONED manual declaration
// names, and it compares this list against the kit's roster from the kit side, which is
// the only place the two hand-maintained mirrors can be compared at all. It holds itself
// to its own rule: it is a roster member, so dropping it fails it.
const REQUIRED = [
  'check-cache-prefix', 'check-prompt-inventory', 'check-steer-delivery',
  'check-message-prefix', 'check-assembled-context', 'check-reanswer-ghost',
  // UX-REPAIR T67b (2026-08-31): cross-turn message-prefix invariance across N DIFFERENT
  // asks. `check-message-prefix` guards the same region with a FIXED ask by design, which is
  // a strictly weaker statement than the one a real conversation makes.
  'check-prefix-holds-still',
  'check-roster-conformance',
];

const HOW = [
  '',
  '  Produce one the normal way — this is not a file to write by hand:',
  '    cd dojo && node ../dojo-test-kit/server-instruments/install.mjs',
  '    cd ../dojo-test-kit && node checks/run-prompt-gates.mjs',
  '    cd ../dojo && node ../dojo-test-kit/server-instruments/uninstall.mjs   # never ship with them in',
  '',
  '  The writer refuses to produce a record when the server is down, when it cannot read the',
  '  platform sha from the listening process, or when the instruments are not installed — so a',
  '  record that exists means the checks really ran against a tree that can be named.',
];

function refuse(headline, ...detail) {
  console.error(`\n✗ prompt-gate record: ${headline}`);
  for (const d of detail) console.error(`  ${d}`);
  for (const l of HOW) console.error(l);
  console.error('');
  process.exit(1);
}

// ── 1/2. The record must exist and parse ──
if (!fs.existsSync(RECORD)) {
  refuse(
    'NO RECORD.',
    `Looked for: ${RECORD}`,
    `The ${REQUIRED.length} prompt gates cannot run inside a release, so the release reads their recorded result.`,
    'No record means nobody can say whether the cached prefix still holds for the code being shipped.',
  );
}
let rec;
try {
  rec = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
} catch (e) {
  refuse('the record is not readable JSON.', `${RECORD}`, e.message);
}
if (!rec || !Array.isArray(rec.checks) || rec.checks.length === 0) {
  refuse('the record carries no checks[] array.', `${RECORD}`);
}

// ── 3. It must describe the tree being shipped ──
const sha = rec.platform?.sha ?? null;
if (!sha) {
  refuse('the record does not name the platform sha it measured.', 'A result that cannot be tied to a tree is not evidence about that tree.');
}
if (sha !== HEAD) {
  refuse(
    'the record measured a DIFFERENT tree than the one being released.',
    `record platform sha: ${sha.slice(0, 12)}`,
    `release HEAD:        ${HEAD.slice(0, 12)}`,
    'A change landed after the prompt gates ran. Re-run them against this HEAD.',
  );
}

// ── 4. Freshness ──
const writtenAt = Date.parse(rec.writtenAt ?? '');
if (!Number.isFinite(writtenAt)) refuse('the record has no readable writtenAt timestamp.');
const ageH = (Date.now() - writtenAt) / 3600000;
if (ageH > MAX_AGE_H) {
  refuse(
    `the record is ${ageH.toFixed(1)}h old (limit ${MAX_AGE_H}h).`,
    'The sha matches, so the code is the same — but the dev-box state these checks read (agent roster,',
    'published techniques, receipts) drifts, and a day-old reading of it is not this release.',
  );
}
if (ageH < -0.5) refuse(`the record is dated ${Math.abs(ageH).toFixed(1)}h in the FUTURE. Refusing to reason about it.`);

// ── 5/6/7. Every rostered check, judged on its own exit code ──
const byId = new Map(rec.checks.map((c) => [c.id, c]));
const missing = REQUIRED.filter((id) => !byId.has(id));
if (missing.length) {
  refuse(
    `${missing.length} rostered check(s) are absent from the record: ${missing.join(', ')}.`,
    'A gate that stops appearing must be removed from the roster in both files, deliberately.',
  );
}

console.log(`prompt-gate record — ${path.relative(ROOT, RECORD)}`);
console.log(`  platform ${sha.slice(0, 8)} (matches release HEAD), written ${ageH.toFixed(1)}h ago by ${rec.writtenBy ?? '(unknown)'}`);
console.log(`  instruments were installed when it ran: ${rec.instruments?.installed === true ? 'yes' : 'NOT RECORDED'}`);
console.log('');

const failures = [];
const acknowledged = [];
for (const id of REQUIRED) {
  const c = byId.get(id);
  const kf = c.knownFailing ?? null;
  let verdict;
  if (!kf) {
    if (c.exit === 0) verdict = 'GREEN';
    else { verdict = `REFUSED (exit ${c.exit})`; failures.push(`${id} exited ${c.exit} and declares no known-failing owner — this gate is blocking.`); }
  } else if (c.exit === 1) {
    verdict = `KNOWN-FAILING → ${kf.issue}`;
    acknowledged.push({ id, issue: kf.issue, reason: kf.reason });
  } else if (c.exit === 0) {
    verdict = 'REFUSED (passes but still declares known-failing)';
    failures.push(
      `${id} exited 0 while still exporting knownFailing (${kf.issue}). The fix landed and the marker did not ` +
      `get deleted, so the next genuine regression would be excused. Delete the export in the task that fixed it.`,
    );
  } else {
    verdict = `REFUSED (exit ${c.exit})`;
    failures.push(`${id} exited ${c.exit} — not 0 and not its acknowledged 1. Exit 2 is an environment failure and exit 3 a broken probe; neither proves anything.`);
  }
  console.log(`  ${id.padEnd(24)} exit ${String(c.exit).padEnd(3)} ${verdict}`);
  console.log(`      ${String(c.summary ?? '').slice(0, 150)}`);
}

if (acknowledged.length) {
  console.log('');
  console.log('  CARRIED INTO THE RELEASE RECORD AS ACKNOWLEDGED RED — not a pass, never whitelisted:');
  for (const a of acknowledged) {
    console.log(`    ${a.id} → owner ${a.issue}`);
    if (a.reason) console.log(`      ${a.reason.slice(0, 200)}`);
  }
}

if (failures.length) {
  console.error('');
  console.error(`✗ prompt-gate record: ${failures.length} blocking finding(s).`);
  for (const f of failures) console.error(`  · ${f}`);
  for (const l of HOW) console.error(l);
  console.error('');
  process.exit(1);
}

console.log('');
console.log(
  `✓ prompt-gate record accepted — ${REQUIRED.length - acknowledged.length} blocking gate(s) green, ` +
  `${acknowledged.length} acknowledged red(s) carrying their owner, at ${sha.slice(0, 8)}, ${ageH.toFixed(1)}h old.`,
);
