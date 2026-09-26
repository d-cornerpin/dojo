#!/usr/bin/env node
// ════════════════════════════════════════
// THE NAMES / PII GATE — nothing that ships carries a person's or an agent's name.
//
// ── THE RULE (owner, 2026-09-26, verbatim) ──
//   "in no code, comments, or documentation that goes live should we be including any agents names,
//    peoples names, identifiable information of any kind"
//   "nothing about your code should be reliant on any specific agent names"
//
// The v3.2.0 audit found the shipped tree violating it in 109 places across 51 files, and one of
// those was the owner's own credential inventory as string literals in a live data structure. The
// scrub that followed (batches A-C) is a one-time clean-up; THIS is what stops the inflow, because
// worker measurement notes naming the box's agents are a steady-state habit, not a one-off mess.
//
// ── ⚠ THE ONE RULE THIS FILE MUST NEVER BREAK ──
// IT MAY NOT CONTAIN A PERSONAL NAME. It lives in a PUBLIC repository, so a gate that hard-codes
// "the names to look for" is the leak it was built to prevent. So:
//
//   · THE ROSTER HALF IS READ AT RUNTIME, from `agents.name` in the local database, and nothing is
//     written down here. On a box with no database the roster half SKIPS, loudly, and says what it
//     could not check — a skip is never silence.
//   · THE PATTERN HALF holds only SHAPES — a home-directory username, an email address, a personal
//     GitHub handle in prose — never an instance of one. Every pattern has a fixture row below
//     proving what it catches AND what it must ignore (the census-reader law of this branch: a
//     matcher with no negative fixtures is a matcher nobody has tested).
//
// ── WHAT COUNTS AS A SHIPPED SURFACE ──
// The same corpus rules the other gates use, and they are not a guess:
//   · `packages/*/src/**/*.ts(x)` COMPILES INTO `dist`, and `tsconfig.base.json` does NOT set
//     `removeComments` — so every comment ships. That is the audit's §1.2 finding and the reason
//     this gate reads comments at all.
//   · `packages/server/src/db/migrations/*.sql`, `packages/server/src/tools/docs/*.md` and
//     `templates/*.md` are RAW-COPIED by `deploy/build-package.sh` (:57-58, :72-79, :129-130).
//   · `deploy/scripts/**` is raw-copied and runs on the user's box.
//   · TESTS ARE EXCLUDED because they do not ship: `packages/server/tsconfig.json` excludes
//     `src/**/__tests__/**` and `src/**/*.test.ts`, and the packager copies `dist` wholesale.
//     (Standing hazard, stated: `packages/shared/tsconfig.json` has no `exclude`, so the day a
//     `packages/shared/src/*.test.ts` appears it WILL ship. This gate scans shared's tests for that
//     reason — see SHARED_TESTS_SHIP.)
//
// ── WHAT IS NOT A LEAK, AND WHY EACH EXEMPTION IS SAFE ──
//   · THE SERVICE-AGENT ROLE NAMES (`Agent`, `PM`, `Trainer`, `Imaginer`, `Healer`, `Dreamer`) are
//     product vocabulary, and they are READ FROM `config/platform.ts`'s own defaults rather than
//     listed here — so a renamed role cannot turn this gate into a false alarm, and a new role is
//     covered the day it is declared.
//   · THE PUBLIC REPOSITORY SLUG is the product's own address; it is read from
//     `report/repo.ts`'s `DOJO_REPORT_REPO_DEFAULT` rather than typed here.
//   · VENDOR IDENTIFIERS that happen to be first names (the TTS voice ids) are exempt by SHAPE —
//     `am_michael` is a snake_case identifier, and the roster half only matches whole words.
//   · PLACEHOLDERS are the point of the exercise, not a violation: `/Users/<you>/`, `/Users/me/`,
//     `<a name>`, `Firstname-Lastname`.
//
// Usage:  node deploy/checks/check-no-personal-names.mjs [--verbose] [--self-test]
// ════════════════════════════════════════
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const VERBOSE = process.argv.includes('--verbose');

// ── THE SHIPPED CORPUS ──────────────────────────────────────────────────────
const SHIPPED = [
  /^packages\/[^/]+\/src\/.*\.(?:ts|tsx)$/,
  /^packages\/server\/src\/db\/migrations\/.*\.sql$/,
  /^packages\/server\/src\/tools\/docs\/.*\.md$/,
  /^templates\/.*\.md$/,
  /^deploy\/scripts\/.*$/,
];
// Tests do not ship — except from `packages/shared`, whose tsconfig has no `exclude`.
const SHARED_TESTS_SHIP = /^packages\/shared\/src\/.*(?:__tests__|\.test\.tsx?)/;
const NOT_SHIPPED = (rel) =>
  !SHARED_TESTS_SHIP.test(rel) && /(?:^|\/)__tests__\//.test(rel) === false
    ? /\.(?:test|spec)\.tsx?$/.test(rel)
    : /(?:^|\/)__tests__\//.test(rel);

function shippedFiles() {
  return execSync("git ls-files", { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean)
    .filter((rel) => SHIPPED.some((re) => re.test(rel)))
    .filter((rel) => SHARED_TESTS_SHIP.test(rel) || !NOT_SHIPPED(rel));
}

// ── THE PRODUCT'S OWN VOCABULARY, READ RATHER THAN LISTED ───────────────────
function roleNames() {
  const src = fs.readFileSync(path.join(ROOT, 'packages/server/src/config/platform.ts'), 'utf8');
  const names = [...src.matchAll(/get\('\w+_agent_name',\s*'([A-Za-z]+)'\)/g)].map((m) => m[1]);
  if (names.length === 0) {
    console.error('✗ names gate: could not read the role-name defaults out of config/platform.ts — '
      + 'the exemption list is derived from them, and deriving nothing would flag the product\'s own '
      + 'vocabulary as a leak.');
    process.exit(1);
  }
  return new Set(names.map((n) => n.toLowerCase()));
}
function publicSlug() {
  const src = fs.readFileSync(path.join(ROOT, 'packages/server/src/report/repo.ts'), 'utf8');
  const m = src.match(/DOJO_REPORT_REPO_DEFAULT\s*=\s*'([^']+)'/);
  return m ? m[1] : null;
}

/**
 * THE DATED ALLOWLIST — findings that are EXPLAINED rather than ignored.
 *
 * Same shape `check-wiring.mjs` uses for its ghosts: a path, the date, the owner who will resolve it,
 * and the reason it survives today. It is printed on EVERY run, it holds no name, and a stale entry
 * (the file is clean now, or gone) FAILS — so it cannot quietly become a permanent exemption.
 */
const ALLOWLIST = [
  {
    path: 'packages/server/src/vault/maintenance.ts',
    date: '2026-09-26',
    owner: 'OWNER — the v3.2.0 audit\'s §10 question',
    reason:
      'The Dreamer\'s archive-processing PROMPT illustrates conversation attribution with example '
      + 'party tags and two example sentences. The names in it are the same class the audit could not '
      + 'settle — "whether Bob, Ben, Sarah, Josh, Marcus, Alex Chen, Verve Health and Sarah Chen are '
      + 'fictional or real … Owner\'s call" — and one of them is literally on that list. Rewriting a '
      + 'prompt\'s examples changes what every Dreamer run is taught, so it waits for his word rather '
      + 'than being guessed at by a scrub. Resolve with the §10 answer, in the same pass as the other '
      + 'fixture names.',
  },
];

// ── HALF ONE: THE LIVE ROSTER (read at runtime, never written down) ─────────
function liveRoster() {
  const dbPath = path.join(process.env.DOJO_HOME ?? os.homedir(), '.dojo/data/dojo.db');
  if (!fs.existsSync(dbPath)) return { available: false, names: [], dbPath };
  try {
    // `sqlite3 -readonly` rather than a driver: this gate must not be able to write, and the CLI is
    // what every other read-only instrument in this tree uses.
    const out = execSync(`sqlite3 -readonly ${JSON.stringify(dbPath)} "SELECT name FROM agents"`,
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const names = out.split('\n').map((s) => s.trim()).filter(Boolean);
    return { available: true, names, dbPath };
  } catch (err) {
    return { available: false, names: [], dbPath, error: err instanceof Error ? err.message : String(err) };
  }
}

// GitHub's own service paths. `github.com/login/device` is the device-flow URL, not a person.
const NOT_AN_ACCOUNT = new Set([
  'login', 'repos', 'user', 'users', 'orgs', 'settings', 'apps', 'marketplace', 'features',
  'pricing', 'about', 'explore', 'topics', 'notifications', 'search', 'codespaces', 'sponsors',
  'security', 'enterprise', 'collections', 'trending', 'new', 'organizations',
]);

/**
 * FILES WHERE A ROSTER NAME IS NOT A LEAK, each with the reason it is exempt.
 *
 * This is a FILE list, never a NAME list — the difference matters, because a name list in a public
 * repo is the leak this gate exists to prevent. The four entries are the vendor voice catalogues: a
 * TTS voice id like `nova` or `am_michael` is a product identifier from Kokoro/OpenAI, and the day
 * somebody on the box names an agent after one, the roster half would otherwise flag the vendor's
 * own vocabulary. The audit settled this class in its §2.
 */
const ROSTER_EXEMPT_FILES = new Map([
  ['packages/server/src/voice/tts-service.ts', 'vendor TTS voice ids (Kokoro)'],
  ['packages/server/src/services/voice-catalog.ts', 'vendor TTS voice catalogue'],
  ['packages/server/src/services/audio-generation.ts', 'vendor TTS/music voice ids'],
  ['packages/server/src/services/capabilities.ts', 'names a vendor voice in a capability example'],
]);

// ── HALF TWO: THE PATTERN SET — shapes only, never instances ────────────────
// Each entry: what it is, the matcher, and the reason a near-miss must NOT fire.
const PATTERNS = [
  {
    id: 'home-path-username',
    // /Users/<name>/ where <name> is not a placeholder. Placeholders are the fix, not the defect.
    re: /\/Users\/(?!<|\.\.\.|me\/|you\/|your-user|name>|old>|user\/|username\/)([A-Za-z][A-Za-z0-9._-]{1,31})\//g,
    why: 'a real account name in a home-directory path identifies the machine\'s owner',
  },
  {
    id: 'email-address',
    // A real-looking address. The documented example domains are how you write one safely.
    // The local part may be a placeholder (`name@`, `user@`, `you@`, `someone@`) and the domain may
    // be any documented example domain, including a subdomain of one (`northwind.example.com` is how
    // the prompt docs write a fictional company).
    re: /\b(?!name@|user@|you@|someone@|anyone@|noreply@|no-reply@)[A-Za-z0-9._%+-]+@(?![A-Za-z0-9.-]*example\.(?:com|org|net)\b|x\.com\b|org\.com\b|odata\.bind\b|icloud\.com\b|anthropic\.com\b|domain\.com\b|email\.com\b|company\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    why: 'an address that is not one of the documented example domains is somebody\'s real inbox',
  },
  {
    id: 'personal-github-handle',
    // A GitHub URL naming an account, or prose that says "GitHub user/handle/account <x>". The
    // product's own org and repo are subtracted at match time (read from `report/repo.ts`).
    //
    // ⚠ THE FIRST CUT OF THIS PATTERN ALSO MATCHED "as `<word>`" — the shape of the audit's own hit
    // (``filing as `<handle>``) — and it reported 100+ findings across the tree, because "as
    // `claimed`" and every other backticked word in every comment matched it. It is recorded rather
    // than quietly dropped: a pattern that fires on ordinary prose gets the gate disabled, which is
    // worse than the leak. The prose shape is left to the roster half and to review.
    // A URL naming an account AND NOTHING ELSE (`github.com/<who>` with no repo path), or prose that
    // says "GitHub user/handle/account <x>". `github.com/<org>/<repo>` is a SOFTWARE ADDRESS — the
    // product's own, an upstream CLI it shells out to, a vendor's price list — and those are public
    // project locations, not personal information. GitHub's own service paths (`/login/device`,
    // `/repos/...`, `/user`) are not accounts either and are subtracted by NOT_AN_ACCOUNT.
    // The prose arm requires the handle to be QUOTED (`github user \`someone\``), because that is how
    // a handle is actually written here and because unquoted prose is English: the first cut matched
    // "the GitHub account connected to this Mac" and captured "connected".
    re: /(?:github\.com\/(?![A-Za-z0-9-]+\/[A-Za-z0-9._-])|github\s+(?:user|handle|account)\s+[`'"])([A-Za-z][A-Za-z0-9-]{2,38})\b/gi,
    why: 'a personal account handle is identifying; the product\'s own public slug is exempted',
  },
];

// ── THE FIXTURE TABLE — the census-reader law: caught AND ignored, both proven ──
const FIXTURES = [
  // [ text, expected pattern id or null ]
  // ⚠ EVERY FIXTURE STRING BELOW IS SYNTHETIC, AND THAT IS NOT A STYLE NOTE — IT IS THIS FILE'S ONE
  // RULE. The first cut of this table used the owner's real account name and a real-looking personal
  // address as its positive rows, which would have shipped both into a PUBLIC repository inside the
  // very gate written to keep them out. It was caught by reading the gate's own output. A fixture
  // proves a SHAPE; it never needs a real instance of one.
  ['const p = "/Users/qwertyuser/Documents/x";', 'home-path-username'],
  ['// measured at /Users/zzuser/.dojo/data/dojo.db', 'home-path-username'],
  ['// the owner\'s box: /Users/me/.dojo/logs', null],
  ['// generic: /Users/<you>/taxes.pdf', null],
  ['// generic: /Users/you/Library', null],
  ['// generic: /Users/<your-user>/Desktop', null],
  ['// a path with no user at all: /usr/local/bin/node', null],
  ['await sendMail("a.person@somewhere.test")', 'email-address'],
  ['// reply-to: another.person@corp.test in the header', 'email-address'],
  ['// a placeholder local part is not an inbox: someone@corp.test', null],
  ['// the docs example: user@example.com', null],
  ['// Anthropic\'s own: noreply@anthropic.com', null],
  ['// a Graph API keyword, not an address: user@odata.bind', null],
  ['// the account page, no repo: github.com/someperson', 'personal-github-handle'],
  ['// reported by GitHub user `someperson`', 'personal-github-handle'],
  ['// unquoted prose is English, not a handle: the GitHub account connected to this Mac', null],
  ['// an upstream CLI this shells out to: github.com/someorg/their-tool', null],
  ['// GitHub\'s own device flow: github.com/login/device', null],
  ['// the releases API: api.github.com/repos/owner/name/releases', null],
  ['// a placeholder in a UI hint: name@gmail.com', null],
  ['// a documented example domain, even as a subdomain: anyone.here@northwind.example.com', null],
  ['// the shape the first cut over-matched: read as `claimed` rather than as `done`', null],
  ['// authenticated as `the owner\'s account`, nothing posted', null],
  ['// the product\'s public address: github.com/<SLUG>/issues', null],   // SLUG substituted at runtime
  ['// no handle here at all, just prose about GitHub', null],
];

function runPatterns(text) {
  const hits = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      if (p.id === 'personal-github-handle') {
        const slug = publicSlug();
        const org = slug ? slug.split('/')[0].toLowerCase() : null;
        const repo = slug ? slug.split('/')[1]?.toLowerCase() : null;
        const got = (m[1] ?? '').toLowerCase();
        if (got === org || got === repo) continue;           // the product's own address
        if (NOT_AN_ACCOUNT.has(got)) continue;               // github.com's own service paths
      }
      hits.push({ id: p.id, match: m[0], captured: m[1] ?? null });
    }
  }
  return hits;
}

function selfTest() {
  const slug = publicSlug() ?? 'org/repo';
  let bad = 0;
  console.log('── fixture table: the pattern half, caught and ignored ──');
  for (const [textRaw, want] of FIXTURES) {
    const text = textRaw.replace('<SLUG>', slug);
    const hits = runPatterns(text);
    const got = hits.length ? hits[0].id : null;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${String(got ?? 'ignored').padEnd(24)} want ${String(want ?? 'ignored').padEnd(24)} ${text.slice(0, 62)}`);
  }
  // A roster name must be matched as a WHOLE WORD only, or every vendor identifier that contains one
  // becomes a false alarm.
  const wordOnly = [
    ['// the harness bot ran it', 'Behavior', false],
    ['// BehaviorBot ran it', 'BehaviorBot', true],
    ['    am_michael: { language: \'en-us\' },', 'Michael', false],
    ['// asked Michael about it', 'Michael', true],
    ['const sticky = true;', 'Ticky', false],
  ];
  console.log('── roster matching is whole-word, so vendor identifiers are not names ──');
  for (const [line, name, want] of wordOnly) {
    const got = new RegExp(`\\b${name}\\b`).test(line);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${String(got).padEnd(5)} want ${String(want).padEnd(5)} "${name}" in ${line.trim().slice(0, 50)}`);
  }
  return bad;
}

// ── THE SCAN ────────────────────────────────────────────────────────────────
const roles = roleNames();
const roster = liveRoster();
const files = shippedFiles();

const selfTestBad = selfTest();
if (selfTestBad > 0) {
  console.error(`\n✗ names gate: its OWN fixture table has ${selfTestBad} failure(s). A matcher that `
    + 'cannot pass its own table cannot be trusted to read the tree.');
  process.exit(1);
}
if (process.argv.includes('--self-test')) process.exit(0);

// Roster names worth scanning for: whole words, at least 3 characters, and never a role name.
const rosterNeedles = roster.names
  .filter((n) => n.length >= 3 && /^[A-Za-z][A-Za-z0-9 _-]*$/.test(n))
  .filter((n) => !roles.has(n.toLowerCase()))
  // CASE-SENSITIVE: an agent called `Nova` is a name; the vendor voice id `nova` is an identifier,
  // and the two must not be the same finding. Whole-word, so `am_michael` and `sticky` are not names.
  .map((n) => ({ name: n, re: new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) }));

const findings = [];
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  const rosterExempt = ROSTER_EXEMPT_FILES.has(rel);
  lines.forEach((line, i) => {
    if (!rosterExempt) for (const { name, re } of rosterNeedles) {
      if (re.test(line)) findings.push({ rel, line: i + 1, kind: 'agent-name', detail: name, text: line.trim() });
    }
    for (const h of runPatterns(line)) {
      findings.push({ rel, line: i + 1, kind: h.id, detail: h.captured ?? h.match, text: line.trim() });
    }
  });
}

// ── THE REPORT. It names the FILE and the LINE; it prints the offending token only as a length and
// a class, because this gate's own output is pasted into commit messages and issues.
console.log(`\n── scanned ${files.length} shipped file(s) ──`);
console.log(roster.available
  ? `  roster: ${rosterNeedles.length} live agent name(s) read from the database at check time `
    + `(${roster.names.length} agent row(s) total; role names excluded, nothing written to this file)`
  : `  ⚠ roster half SKIPPED — no database at ${roster.dbPath}. The pattern half still ran. `
    + 'On a developer box with no dojo installed this is expected; in CI it means the agent-name '
    + 'half of this gate did not run and must not be read as a pass.');



const allowed = new Map(ALLOWLIST.map((a) => [a.path, a]));
const honoured = new Set(findings.filter((f) => allowed.has(f.rel)).map((f) => f.rel));
const live = findings.filter((f) => !allowed.has(f.rel));
const stale = ALLOWLIST.filter((a) => !honoured.has(a.path));

if (ALLOWLIST.length > 0) {
  console.log(`  ── ${ALLOWLIST.length} allowlisted file(s), each with a date and an owner ──`);
  for (const a of ALLOWLIST) {
    console.log(`     ${a.path}  (${a.date}, ${a.owner})`);
    console.log(`       ${a.reason.slice(0, 160)}…`);
  }
}
if (stale.length > 0) {
  console.error(`\n✗ names gate: ${stale.length} STALE allowlist entr(y/ies) — the file is clean now or `
    + 'gone, so the exemption is a lie somebody must delete:');
  for (const a of stale) console.error(`    ${a.path} (${a.date}, ${a.owner})`);
  process.exit(1);
}

const byFile = new Map();
for (const f of live) {
  if (!byFile.has(f.rel)) byFile.set(f.rel, []);
  byFile.get(f.rel).push(f);
}
if (live.length === 0) {
  console.log(`✓ no personal or agent names in the shipped surfaces`
    + (ALLOWLIST.length ? ` (${ALLOWLIST.length} allowlisted above, awaiting their owner)` : ''));
  process.exit(0);
}
console.error(`\n✗ names gate: ${live.length} finding(s) in ${byFile.size} shipped file(s).`);
for (const [rel, list] of byFile) {
  console.error(`  ${rel}`);
  for (const f of list) {
    const shown = VERBOSE ? f.detail : `${f.kind === 'agent-name' ? 'agent name' : f.kind}, ${String(f.detail).length} chars`;
    console.error(`    :${f.line}  ${shown}`);
    if (VERBOSE) console.error(`        ${f.text.slice(0, 120)}`);
  }
}
console.error('\n  Comments SHIP: `tsconfig.base.json` does not set `removeComments`, so a note naming');
console.error('  an agent or a person reaches every user\'s disk, and this repository is public.');
console.error('  Replace the name with the ROLE it played — the primary agent, the harness bot, a');
console.error('  sub-agent, a contact — or with a placeholder. The doctrine never needs the name.');
console.error('  Re-run with --verbose to see the tokens (locally only; do not paste that output).');
process.exit(1);
