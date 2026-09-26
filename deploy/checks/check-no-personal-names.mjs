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
//     GitHub handle in prose, a UUID named as an agent's — never an instance of one. Every pattern
//     has a fixture row below proving what it catches AND what it must ignore (the census-reader law
//     of this branch: a matcher with no negative fixtures is a matcher nobody has tested).
//   · TWO MORE RUNTIME READS join the roster, for the same reason it exists (review M1 found all
//     three of these shapes riding GREEN when planted verbatim from the audit): the box's own GITHUB
//     HANDLE and git identity, and the LIVE AGENT UUIDs. Both are derived at check time and neither
//     is written down. Each has a STRUCTURAL partner that works on a box where the read is empty —
//     `github-handle-beside-our-org` and `agent-uuid-in-context` — because a gate whose cover depends
//     on the checking box's own data passes trivially in CI.
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
    owner: 'owner-confirmed fictional 2026-09-26',
    reason:
      'ADJUDICATED, and this entry now records an answer rather than a question. The Dreamer\'s '
      + 'archive-processing PROMPT illustrates conversation attribution with example party tags and two '
      + 'example sentences. The audit could not settle "whether Bob, Ben, Sarah, Josh, Marcus, Alex '
      + 'Chen, Verve Health and Sarah Chen are fictional or real … Owner\'s call"; the OWNER RULED ON '
      + '2026-09-26 THAT ALL OF THE FIXTURE NAMES ARE FICTIONAL, so no real person is named here and '
      + 'there is nothing to scrub. The exemption stays because the hit is a COLLISION, not a leak: '
      + 'the gate matches the live roster, and the invented example agent name happens to equal an '
      + 'agent on the box being checked — it would re-fire on any box whose owner used the same word. '
      + 'What is NOT settled by that ruling, and is deliberately left alone here, is whether a prompt '
      + 'should teach by example agent NAMES at all; rewriting it changes what every Dreamer run is '
      + 'taught, which is a behaviour change and not a scrub\'s business.',
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
/** Words that occupy the handle position but name nobody — the scrub's own replacement vocabulary. */
const HANDLE_PLACEHOLDERS = new Set([
  'you', 'your-user', 'your-handle', 'username', 'user', 'someone', 'somebody', 'me', 'owner',
  'the-owner', 'anyone', 'handle', 'account', 'redacted', 'example', 'org', 'repo',
]);

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

/**
 * ── HALF 1b: THE MACHINE'S OWN IDENTITIES, DERIVED AT CHECK TIME (review M1) ─────────────
 *
 * The audit's §1.5 hit was `` as `dcliff9`, filing against a repository owned by `d-cornerpin` `` — a
 * personal GitHub handle in prose. The first cut of this gate said that shape was "left to the roster
 * half", and the review is right that it cannot be: a GitHub handle is not an agent name, so nothing
 * in the roster would ever match it.
 *
 * It cannot be listed here either — that is this file's one rule. So it is DERIVED, the same way the
 * roster is: from the product's own record of the connected account (`github_account.login`), and from
 * this checkout's git identity. Whatever the box knows about who it is, the gate knows too, and
 * nothing is written down. The product's own org and repo are subtracted, because those are the
 * product's public address rather than anybody's personal handle.
 *
 * ⚠ AND IT IS NOT ENOUGH ON ITS OWN, stated because a derived set can be EMPTY: on the box this was
 * written on, `github_account` holds no row and `git config user.name` is unset, so the derived set is
 * empty and the audit's own line would still ride green. That is what `github-handle-beside-our-org`
 * below is for — a structural shape that needs no name at all.
 */
function derivedIdentities() {
  const out = new Set();
  const dbPath = path.join(process.env.DOJO_HOME ?? os.homedir(), '.dojo/data/dojo.db');
  if (fs.existsSync(dbPath)) {
    try {
      const rows = execSync(`sqlite3 -readonly ${JSON.stringify(dbPath)} "SELECT login FROM github_account"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const l of rows.split('\n').map((x) => x.trim()).filter(Boolean)) out.add(l);
    } catch { /* no table on an older box: the structural shape still runs */ }
  }
  for (const key of ['user.name', 'user.email']) {
    try {
      const v = execSync(`git config --get ${key}`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!v) continue;
      out.add(key === 'user.email' ? v.split('@')[0] : v);
    } catch { /* unset */ }
  }
  const slug = publicSlug();
  if (slug) for (const part of slug.split('/')) out.delete(part);
  return [...out].filter((n) => n.length >= 3 && /^[A-Za-z0-9._-]+$/.test(n));
}

/**
 * Agent UUIDs from the live table (review M1): the audit's §3.1 shipped one FIVE times as a literal.
 * A UUID is an identifier of a specific machine's agent, which is exactly what the rule calls
 * identifiable information — and like the roster, the list is read at check time and never stored.
 */
function liveAgentIds() {
  const dbPath = path.join(process.env.DOJO_HOME ?? os.homedir(), '.dojo/data/dojo.db');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const out = execSync(`sqlite3 -readonly ${JSON.stringify(dbPath)} "SELECT id FROM agents WHERE length(id) >= 32"`,
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((s) => s.trim()).filter((s) => /^[0-9a-f-]{32,}$/i.test(s));
  } catch { return []; }
}

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
    id: 'github-handle-beside-our-org',
    // The audit's §1.5 line, caught WITHOUT knowing any handle: a line that names the product's own
    // GitHub org AND carries a different backticked/quoted identifier is naming somebody's account
    // beside our address. That co-occurrence is what makes it precise where "as `<word>`" alone was a
    // false-positive machine (it matched "as `claimed`" and reported 100+).
    // Two conjuncts, and both are needed. (1) A HANDLE POSITION word — `as`, `owned by`, `account`,
    // `user`, `handle` — immediately before a quoted token, which is how a handle is written in prose.
    // (2) The product's own org somewhere on the same line, which is what made the audit's line a leak
    // rather than a note. The position word is the part that stops `` A `dojo-report` label sweep ``
    // (a LABEL beside our org) from being read as somebody's account — the first cut flagged exactly
    // that, and a label is product vocabulary.
    re: /\b(?:as|owned\s+by|account|user|handle|authenticated\s+as|filing\s+as)\s+[`'"]([A-Za-z][A-Za-z0-9-]{2,38})[`'"]/gi,
    why: 'a personal handle written beside the product\'s own org is the audit\'s own worst prose shape',
    orgAware: true,
    needsOrgOnLine: true,
  },
  {
    id: 'agent-uuid-in-context',
    // A UUID next to a word that says it is an AGENT's. The audit's §3.1 shape is exactly this:
    // `createdBy: '57b52025-…'` and `agent 57b52025-…`, five times in one shipped file.
    //
    // ⚠ A BARE-UUID PATTERN WAS TRIED FIRST AND WAS WRONG: it flagged Microsoft's published
    // `CLIENT_ID`/`MSA_TENANT_ID` constants (vendor identifiers) and an `ask:` WORK-row id in a comment
    // example. Neither identifies a person or an agent. The context word is what makes this precise,
    // and the exact live-agent-id pass below is what catches a UUID with no context word at all.
    re: /\b(?:agent|agent_?id|createdBy|created_by\w*|owner_?agent)\b[^\n]{0,24}?\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi,
    why: 'a UUID named as an agent\'s identifies one machine\'s agent',
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
    // worse than the leak. ⚠ AN EARLIER VERSION OF THIS NOTE THEN CLAIMED THE PROSE SHAPE WAS "LEFT
    // TO THE ROSTER HALF", AND REVIEW M1 CORRECTLY CALLED THAT FALSE: a GitHub handle is not an agent
    // name, so no roster read can ever see it. The shape is now covered by
    // `github-handle-beside-our-org` above, which earns its precision from TWO conjuncts instead of
    // one loose one — see its own note.
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

  // ── review M1: the handle-beside-our-org shape. TWO conjuncts, so both halves get ignored rows ──
  ['// the bot authenticates as `qwertyuser`, filing against <SLUG>, nothing posted', 'github-handle-beside-our-org'],
  ['// <SLUG> issues are opened by user `zzuser` on the owner\'s behalf', 'github-handle-beside-our-org'],
  ['// a repository owned by `someperson` — see <SLUG>', 'github-handle-beside-our-org'],
  // ⚠ THE FALSE POSITIVE THAT THE FIRST CUT ACTUALLY PRODUCED, kept as a permanent row: a LABEL name
  // beside our org is product vocabulary, and the only thing separating it from a handle is the
  // absence of a handle-position word. This exact line is live in `github/issues.ts`.
  ['// `<SLUG>` — arrives unlabelled. A `dojo-report` label sweep finds none of them, and', null],
  ['// the handle position with no org on the line: authenticated as `qwertyuser`', null],
  ['// our own org in the handle position: a repository owned by `<ORG>`, see <SLUG>', null],
  ['// the placeholder the scrub itself writes: filing as `<you>` against <SLUG>', null],
  ['// a generic word in the handle position: the user `you` in <SLUG> docs', null],
  ['// prose about <SLUG> with no quoted token at all', null],

  // ── review M1: a UUID named as an AGENT's. The context word is the whole precision argument ──
  // (Synthetic UUIDs, per this table's one rule. The audit's real instance is a LIVE agent id on the
  // owner's box, and quoting it here to prove a shape would ship exactly what the shape forbids.)
  ['{ createdBy: \'7f3a91c2-4d5e-4a6b-8c7d-9e0f1a2b3c4d\' },', 'agent-uuid-in-context'],
  ['// agent 7f3a91c2-4d5e-4a6b-8c7d-9e0f1a2b3c4d owns the row', 'agent-uuid-in-context'],
  ['const agentId = \'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\';', 'agent-uuid-in-context'],
  // The two shapes that made a bare-UUID pattern unusable, kept so nobody widens it back:
  ['const CLIENT_ID = \'9e5f94bc-e8a4-4e73-b8be-63364c29d753\'; // Microsoft\'s published id', null],
  ['// the work row: ask:11111111-2222-3333-4444-555555555555', null],
  ['// a plain uuid in a doc example: 11111111-2222-3333-4444-555555555555', null],
];

function runPatterns(text) {
  const hits = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      if (p.needsOrgOnLine) {
        const slug = publicSlug();
        const org = slug ? slug.split('/')[0] : null;
        if (!org || !text.toLowerCase().includes(org.toLowerCase())) continue;
      }
      if (p.id === 'github-handle-beside-our-org') {
        // A placeholder in the handle position is the CURE, not the disease — the scrub's own
        // replacements read `as \`<you>\`` and `the user \`you\``, and a gate that flags its own
        // remedy trains people to disable it.
        const got = (m[1] ?? '').toLowerCase();
        if (HANDLE_PLACEHOLDERS.has(got) || got.startsWith('<')) continue;
      }
      if (p.orgAware) {
        const slug = publicSlug();
        const parts = new Set((slug ?? '').split('/').map((x) => x.toLowerCase()));
        const got = ((m[1] ?? m[2]) ?? '').toLowerCase();
        if (parts.has(got)) continue;      // the product's own org or repo, written beside itself
      }
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
    const text = textRaw.replaceAll('<SLUG>', slug).replaceAll('<ORG>', slug.split('/')[0]);
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
  // ── review M1's second shape: an agent name written LOWERCASE as DATA. The rule is deliberately
  // narrower than the case-sensitive one — quoted only — because that is what separates the audit's
  // `createdBy: 'kevin'` from a vendor voice id or an ordinary English word that happens to collide.
  const quotedLower = [
    ["    { serviceName: 'sendgrid', createdBy: 'kevin', createdOn: '2026-06-21' },", 'Kevin', true],
    ["const owner = \"kevin\";", 'Kevin', true],
    ['const owner = `kevin`;', 'Kevin', true],
    ["// prose about kevin outside any quotes", 'Kevin', false],
    ["const kevinCount = 1;   // an identifier, not data", 'Kevin', false],
    ["// a quote that spans no name: 'the primary agent'", 'Kevin', false],
    ["  am_michael: { language: 'en-us' },", 'Michael', false],
    ["  { voice: 'am_michael' },", 'Michael', false],
  ];
  console.log('── an agent name written lowercase as DATA (quoted only) ──');
  for (const [line, name, want] of quotedLower) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const got = new RegExp(`['\"\`][^'\"\`\n]*\\b${esc}\\b[^'\"\`\n]*['\"\`]`, 'i').test(line);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${String(got).padEnd(5)} want ${String(want).padEnd(5)} "${name}" in ${line.trim().slice(0, 52)}`);
  }
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
const handles = derivedIdentities();
const agentIds = liveAgentIds();
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
  .map((n) => {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      name: n,
      re: new RegExp(`\\b${esc}\\b`),
      // the same needle, case-insensitively, but ONLY inside a quoted string (see the site below)
      lower: new RegExp(`['"\`][^'"\`\n]*\\b${esc}\\b[^'"\`\n]*['"\`]`, 'i'),
    };
  });

const findings = [];
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  const rosterExempt = ROSTER_EXEMPT_FILES.has(rel);
  lines.forEach((line, i) => {
    if (!rosterExempt) for (const { name, re, lower } of rosterNeedles) {
      if (re.test(line)) findings.push({ rel, line: i + 1, kind: 'agent-name', detail: name, text: line.trim() });
      // ⚠ THE LOWERCASE PASS, and review M1 is why it exists: the roster match is case-SENSITIVE so a
      // vendor voice id (`nova`) is not an agent called `Nova` — and that let the audit's own worst
      // finding ride green, because `createdBy: 'kevin'` is the roster name in a LIVE STRING LITERAL.
      // Case-insensitivity is therefore restricted to QUOTED strings: an agent id written as data is
      // the shape that shipped, while a bare lowercase identifier stays exempt.
      else if (lower.test(line)) findings.push({ rel, line: i + 1, kind: 'agent-name-in-string', detail: name, text: line.trim() });
    }
    for (const id of agentIds) {
      if (line.includes(id)) findings.push({ rel, line: i + 1, kind: 'live-agent-id', detail: id, text: line.trim() });
    }
    for (const h of handles) {
      if (new RegExp(`\\b${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(line)) {
        findings.push({ rel, line: i + 1, kind: 'derived-identity', detail: h, text: line.trim() });
      }
    }
    for (const h of runPatterns(line)) {
      findings.push({ rel, line: i + 1, kind: h.id, detail: h.captured ?? h.match, text: line.trim() });
    }
  });
}

// ── THE REPORT. It names the FILE and the LINE; it prints the offending token only as a length and
// a class, because this gate's own output is pasted into commit messages and issues.
console.log(`\n── scanned ${files.length} shipped file(s) ──`);
console.log(`  identities derived at check time: ${handles.length} handle(s) (github_account.login + git `
  + `config, product org/repo subtracted), ${agentIds.length} live agent id(s)`
  + (handles.length === 0 ? ' — ⚠ NO handle derivable on this box, so the structural '
    + '`github-handle-beside-our-org` shape is the only handle cover here' : ''));
console.log(roster.available
  ? `  roster: ${rosterNeedles.length} live agent name(s) read from the database at check time `
    + `(${roster.names.length} agent row(s) total; role names excluded, nothing written to this file)`
  : `  ⚠ roster half SKIPPED — no database at ${roster.dbPath}. The pattern half still ran. `
    + 'On a developer box with no dojo installed this is expected; in CI it means the agent-name '
    + 'half of this gate did not run and must not be read as a pass.');



// Two shapes catching the same token at the same site is the intended overlap (a derived handle is
// also structurally a handle beside the org; a live agent id is also a UUID in context) — report each
// KIND once and no more, so the count is a count of problems rather than of rules.
const deduped = [];
const seenFinding = new Set();
for (const f of findings) {
  const key = `${f.rel}\u0000${f.line}\u0000${f.kind}\u0000${f.detail}`;
  if (seenFinding.has(key)) continue;
  seenFinding.add(key);
  deduped.push(f);
}

const allowed = new Map(ALLOWLIST.map((a) => [a.path, a]));
const honoured = new Set(deduped.filter((f) => allowed.has(f.rel)).map((f) => f.rel));
const live = deduped.filter((f) => !allowed.has(f.rel));
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
    + (ALLOWLIST.length ? ` (${ALLOWLIST.length} allowlisted above, each with its adjudication)` : ''));
  process.exit(0);
}
console.error(`\n✗ names gate: ${live.length} finding(s) in ${byFile.size} shipped file(s).`);
for (const [rel, list] of byFile) {
  console.error(`  ${rel}`);
  for (const f of list) {
    const kind = f.kind === 'agent-name' ? 'agent name' : f.kind;
    const shown = VERBOSE ? `${kind} → ${f.detail}` : `${kind}, ${String(f.detail).length} chars`;
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
