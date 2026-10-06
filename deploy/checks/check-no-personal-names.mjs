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
// ── WHAT COUNTS AS A SCANNED SURFACE: TWO CORPORA, NOT ONE ──
// ⚠ THE FIRST CUT OF THIS GATE SCANNED ONLY WHAT REACHES A USER'S DISK, AND THAT WAS HALF THE RULE.
// Three reviewers of the v3.3 campaign found the same hole independently: tests, `deploy/checks/**`
// and the root gate JSON were excluded BY DESIGN, so the owner's rule was enforced on them by review
// only — and review missed the owner's own first name in a fixture, his agents' names in 169 test
// files, his real email addresses and GitHub handle in four more, and three measurement notes in
// `ratchets.json` that name the box's agents. The rule says "anything that goes live". THIS
// REPOSITORY IS PUBLIC, so a name in a test file is published the moment it is pushed, exactly as
// surely as a name in a comment that compiles into `dist`. Hence two corpora:
//
//   SHIPPED — reaches a user's disk:
//   · `packages/*/src/**/*.ts(x)` COMPILES INTO `dist`, and `tsconfig.base.json` does NOT set
//     `removeComments` — so every comment ships. That is the audit's §1.2 finding and the reason
//     this gate reads comments at all.
//   · `packages/server/src/db/migrations/*.sql`, `packages/server/src/tools/docs/*.md` and
//     `templates/*.md` are RAW-COPIED by `deploy/build-package.sh` (:57-58, :72-79, :129-130).
//   · `deploy/scripts/**` is raw-copied and runs on the user's box.
//
//   PUBLIC — never reaches `dist`, but every byte of it is readable by anyone on the internet:
//   · every `__tests__/**` and `*.test.*`/`*.spec.*` under `packages/*/src`. (`packages/server`'s
//     tsconfig excludes them from `dist`, which is why they were argued out of the first cut; it is
//     also irrelevant to a public repository. `packages/shared`'s tsconfig has NO `exclude`, so its
//     tests ship as well — that file-shape used to need its own clause and no longer does, because
//     the two corpora together cover it either way.)
//   · `watchdog/src/**/*.ts` — product code that the packager builds separately.
//   · `deploy/checks/**` — the gate sources, their fixtures, `gate-manifest.mjs`,
//     `growth-baseline.json`, `spine-manifest.json` and `capability-ledger.csv`.
//   · `deploy/release.sh`, `ratchets.json`, `lint-baseline.json` — the pin and ritual files, whose
//     `why` prose is where worker measurement notes name the box's agents.
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

// ── CORPUS ONE: WHAT REACHES A USER'S DISK ──────────────────────────────────
const SHIPPED = [
  /^packages\/[^/]+\/src\/.*\.(?:ts|tsx)$/,
  /^packages\/server\/src\/db\/migrations\/.*\.sql$/,
  /^packages\/server\/src\/tools\/docs\/.*\.md$/,
  /^templates\/.*\.md$/,
  /^deploy\/scripts\/.*$/,
];

// ── CORPUS TWO: WHAT REACHES THE PUBLIC REPOSITORY ──────────────────────────
// Nothing here is excluded for "not shipping" any more; see the header. A file matching PUBLIC is
// scanned whether or not SHIPPED also claims it, which is why `packages/shared`'s tests no longer
// need the special case the first cut gave them.
const PUBLIC = [
  /^packages\/[^/]+\/src\/.*(?:(?:^|\/)__tests__\/|\.(?:test|spec)\.tsx?$)/,
  /^watchdog\/src\/.*\.ts$/,
  /^deploy\/checks\/.*$/,
  /^deploy\/release\.sh$/,
  /^(?:ratchets|lint-baseline)\.json$/,
];

function scannedFiles() {
  return execSync("git ls-files", { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean)
    .filter((rel) => PUBLIC.some((re) => re.test(rel)) || SHIPPED.some((re) => re.test(rel)));
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
// ── RETIRED 2026-10-05 (t107, OWNER RULING #5): the one entry this list ever carried is gone ──
// It exempted `packages/server/src/vault/maintenance.ts`, whose Dreamer archive-processing
// PROMPT illustrated conversation attribution with example party tags. The hit was a COLLISION
// rather than a leak — the gate matches the LIVE roster, and one invented example name happened
// to equal an agent on the box being checked, so it would re-fire on any box whose owner used
// the same word. The 2026-09-26 adjudication settled that the names were fictional and left one
// question open IN SO MANY WORDS: *"whether a prompt should teach by example agent NAMES at all;
// rewriting it changes what every Dreamer run is taught, which is a behaviour change and not a
// scrub's business."* OWNER RULING #5 (2026-10-05) answered it — anonymous placeholders — and
// the prompts now carry `<the owner>`, `<a contact>`, `<an agent>` and their siblings. There is
// no collision left to exempt, so the entry goes rather than standing as a permanent carve-out.
//
// The product-side clause that replaces it is
// `packages/server/src/prompt/__tests__/a-shipped-prompt-teaches-with-placeholders.test.ts`:
// this gate answers "is this a REAL person", that one answers "is this a person at all".
//
// THE EMPTY LIST IS STILL LOAD-BEARING. The stale-entry check below is what stops an exemption
// becoming permanent, and the printing of this list on every run is what makes one visible. Both
// keep working at length zero; what an empty list means is that nothing in the shipped surfaces
// currently needs explaining, which is the state this gate exists to hold.
const ALLOWLIST = [];

/**
 * THE FIXTURE ROSTER — why a gate that reads a live database needs committed names (t111-C3).
 *
 * t101 concern 3, verbatim: "the roster-driven halves SKIP when no database exists, so they have
 * only run on developer boxes." That is the whole defect. On CI, and on any box that has never
 * run the platform, `liveRoster()` returned an EMPTY list, so `rosterNeedles` was empty and the
 * roster half scanned the tree for nothing. The gate printed a loud skip and exited 0 — so the
 * matching machinery that enforces the TOP RULE had never run anywhere but a developer's own
 * machine, where the one roster it reads is the one roster it cannot be tested against.
 *
 * The fallback is three INVENTED names. They are not examples of the rule being broken: they ARE
 * the needles, and the tree containing none of them is the gate passing. Each was measured to
 * have ZERO occurrences in the repository at this commit, so a hit is a real regression — a
 * shipped surface that genuinely gained that word — and never this fixture finding itself.
 *
 * ⚠ G1 / THE TOP RULE: a committed roster may never hold a real name. The live roster still WINS
 * wherever a database exists, so this list never weakens what a real box checks; it only replaces
 * measuring NOTHING with measuring something, on the boxes that were measuring nothing.
 */
// ⚠ THE THREE NAMES THEMSELVES LIVE INSIDE THE CORPUS FENCE, far below, and they have to.
// This file is itself a scanned surface, and the roster half reads prose — so a fictional name
// written HERE is found by the very machinery it exists to drive, and the gate reports its own
// fixture. (Measured, not predicted: declaring it here failed the gate with three 8-character
// "agent name" hits in this file on a no-database box.) The fence is the one place a name is
// allowed to be an instance rather than a defect, which is exactly what these are.
// See `FIXTURE_ROSTER` at the end of the corpus block.

/**
 * ONE needle builder, used by the SCAN and by the SELF-TEST.
 *
 * Extracted rather than duplicated, because the self-test's job is to prove the machinery the
 * scan actually runs. The older fixture tables (`FIX_WORD_ONLY`, `FIX_QUOTED_LOWER`) build their
 * own inline regexes, so they proved the SHAPE of a needle and never the pipeline that produces
 * one — the two filters included. A second copy here would be that same gap in fixture clothing.
 *
 * CASE-SENSITIVE for the bare pass: an agent NAMED AFTER a vendor voice id is a name, while the
 * lowercase voice id itself is an identifier, and the two must not be the same finding. The
 * concrete pair lives in FIX_QUOTED_LOWER inside the fence; writing it here would put a live name
 * in the doctrine, which is the exact defect this file's own review caught. Whole-word, so
 * `am_michael` and `sticky` are not names.
 */
function rosterNeedleFor(n) {
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    name: n,
    re: new RegExp(`\\b${esc}\\b`),
    // the same needle, case-insensitively, but ONLY inside a quoted string (see the site below)
    lower: new RegExp(`['"\`][^'"\`\\n]*\\b${esc}\\b[^'"\`\\n]*['"\`]`, 'i'),
  };
}

/** The filters a roster name passes before it becomes a needle. Shared for the same reason. */
function rosterNeedlesFrom(names, roles) {
  return names
    .filter((n) => n.length >= 3 && /^[A-Za-z][A-Za-z0-9 _-]*$/.test(n))
    .filter((n) => !roles.has(n.toLowerCase()))
    .map(rosterNeedleFor);
}

// ── HALF ONE: THE LIVE ROSTER (read at runtime, never written down) ─────────
function liveRoster() {
  const dbPath = path.join(process.env.DOJO_HOME ?? os.homedir(), '.dojo/data/dojo.db');
  // NO DATABASE: fall back to the committed fictional roster rather than to nothing, so the
  // matching machinery runs in CI. `available` stays FALSE — the run still says out loud that it
  // could not read a real roster, because a skip must never quietly become silence.
  if (!fs.existsSync(dbPath)) {
    return { available: false, source: 'fixture', names: [...FIXTURE_ROSTER], dbPath };
  }
  try {
    // `sqlite3 -readonly` rather than a driver: this gate must not be able to write, and the CLI is
    // what every other read-only instrument in this tree uses.
    const out = execSync(`sqlite3 -readonly ${JSON.stringify(dbPath)} "SELECT name FROM agents"`,
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const names = out.split('\n').map((s) => s.trim()).filter(Boolean);
    return { available: true, names, dbPath };
  } catch (err) {
    // An unreadable database is the same situation as an absent one: measure SOMETHING.
    return {
      available: false, source: 'fixture', names: [...FIXTURE_ROSTER], dbPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// GitHub's own service paths. `github.com/login/device` is the device-flow URL, not a person.
/** Words that occupy the handle position but name nobody — the scrub's own replacement vocabulary. */
const HANDLE_PLACEHOLDERS = new Set([
  'you', 'your-user', 'your-handle', 'username', 'user', 'someone', 'somebody', 'me', 'owner',
  'the-owner', 'anyone', 'handle', 'account', 'redacted', 'example', 'org', 'repo',
]);

/**
 * Words that occupy the home-directory position but name nobody (lane t101). Moved out of the
 * `home-path-username` lookahead, where an incomplete list silently flagged the gate's own remedy.
 */
const PATH_PLACEHOLDERS = new Set([
  'me', 'you', 'your-user', 'your-handle', 'username', 'user', 'a-user', 'the-user', 'someone',
  'somebody', 'anyone', 'owner', 'the-owner', 'an-owner', 'a-person', 'the-person', 'person',
  'redacted', 'example', 'name', 'firstname-lastname', 'nobody', 'shared',
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
 * TTS voice id such as `am_michael` is a product identifier from Kokoro/OpenAI, and the day
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
 * THE ONE CORPUS EXEMPTION (lane t101, D5), and it is as narrow as it can be made.
 *
 * The fenced block is a names-gate TEST CORPUS: every positive row is a deliberate instance of a
 * shape this gate must catch, so pointing the gate at it reports the test suite as the defect. The
 * fence is therefore a REGION, not a file — two sentinel comments, and EVERY HALF (roster, owner,
 * derived identity, live agent id, and the pattern set) skips only the lines between them.
 * Everything else in this file — the doctrine header, the patterns, the matching code, the report —
 * is scanned exactly like any other file in `deploy/checks/**`.
 *
 * ⚠ THE FIRST CUT OF THIS LANE GOT THIS WRONG IN THE MOST EMBARRASSING AVAILABLE WAY, and the note
 * stays because the shape will tempt the next person. It fenced only the PATTERN half here and
 * exempted THE WHOLE FILE from the roster half, on the argument that the vendor-voice-id note cannot
 * be written without naming the collision it is about. The argument was true and the remedy was
 * wrong: a whole-file exemption hid THREE LIVE ROSTER NAMES in this file's own doctrine — two
 * pre-existing, and ONE THIS LANE ITSELF WROTE while explaining a different blind spot. A gate that
 * cannot see its own source is a gate with a permanent hole in exactly the file most likely to
 * receive a pasted measurement. The fix has two halves: the fixture tables MOVED INTO the fence
 * (they are data, so that is where they belong), and the doctrine stopped using real instances —
 * where a note needs to show one, it points at a fenced fixture row instead of writing it inline.
 */
// ⚠ THE SENTINEL STRINGS ARE BUILT FROM PIECES ON PURPOSE, and the first cut's bug is the reason:
// written out whole, each literal here IS an occurrence of the sentinel it searches for, so the
// opener matched this declaration, the closer matched the line below it, and the "fence" enclosed
// two lines of its own definition while the fixture table it exists for stayed exposed. The gate
// reported three of its own fixture rows as findings and that is how it was caught.
const CORPUS_FENCE = {
  file: 'deploy/checks/check-no-personal-names.mjs',
  open: 'BEGIN NAMES-GATE' + ' TEST CORPUS',
  close: 'END NAMES-GATE' + ' TEST CORPUS',
};

/**
 * ── HALF 1b: THE MACHINE'S OWN IDENTITIES, DERIVED AT CHECK TIME (review M1) ─────────────
 *
 * The audit's §1.5 hit was a personal GitHub handle in prose (`` as `<handle>`, filing against a repository owned by `d-cornerpin` ``) — a
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
 * ── HALF 1c: THE OWNER'S OWN NAME, READ AT RUNTIME (v3.3, lane t101) ─────────────────────
 *
 * THE HOLE THIS CLOSES, stated because it is the reason this lane exists: the roster half reads
 * `agents.name`, and the OWNER IS NOT AN AGENT. So `setConfig('owner_name', '<his first name>')` —
 * which two independent reviewers found seeded in seven prompt and gateway fixtures — matched
 * NOTHING. It rode green past a gate named "no personal names" while holding a personal name.
 *
 * On the box this was written on it was caught by accident, and the accident is the argument: the
 * owner's git email local part happens to contain his name, so `derivedIdentities()` covered it.
 * That cover is luck. In CI, and on any box whose git identity is unset or impersonal, the derived
 * set is empty and the seeded name rides again. So the name is read STRUCTURALLY, from the same
 * place the product reads it (`config.owner_name`, the key `config/platform.ts` resolves through
 * `ownerName()`), at check time, and — like the roster — it is never written down here.
 *
 * The product's own FALLBACK is subtracted (`OWNER_NAME_FALLBACK` in `config/platform.ts`, read
 * rather than typed), because a box that never finished setup holds the placeholder, and flagging
 * the placeholder would flag the cure. The anonymising words the scrub itself writes are subtracted
 * for the same reason `HANDLE_PLACEHOLDERS` exists: `the owner`, `a user`, `User`.
 */
function ownerNames() {
  const dbPath = path.join(process.env.DOJO_HOME ?? os.homedir(), '.dojo/data/dojo.db');
  if (!fs.existsSync(dbPath)) return { available: false, names: [] };
  let fallback = null;
  try {
    const src = fs.readFileSync(path.join(ROOT, 'packages/server/src/config/platform.ts'), 'utf8');
    const m = src.match(/OWNER_NAME_FALLBACK\s*=\s*'([^']+)'/);
    fallback = m ? m[1].toLowerCase() : null;
  } catch { /* the roleNames() read above already fails loudly if this file is unreadable */ }
  try {
    const out = execSync(`sqlite3 -readonly ${JSON.stringify(dbPath)} `
      + `"SELECT value FROM config WHERE key = 'owner_name'"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const names = out.split('\n').map((s2) => s2.trim()).filter(Boolean)
      .filter((n) => n.length >= 3 && /^[A-Za-z][A-Za-z0-9 ._-]*$/.test(n))
      .filter((n) => n.toLowerCase() !== fallback)
      .filter((n) => !OWNER_PLACEHOLDERS.has(n.toLowerCase()));
    return { available: true, names };
  } catch { return { available: false, names: [] }; }
}

/** The anonymising words the scrub writes in an owner's place. Flagging the cure trains people off. */
const OWNER_PLACEHOLDERS = new Set([
  'the owner', 'owner', 'a user', 'the user', 'user', 'you', 'me', 'someone', 'somebody',
  'anyone', 'a person', 'the person', 'redacted', 'example', 'nobody',
]);

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
    //
    // ⚠ THE LOOKAHEAD USED TO CARRY THE PLACEHOLDER LIST AND IT WAS INCOMPLETE (lane t101): widening
    // the corpus to tests surfaced `/Users/someone/` and `/Users/a-user/` beside a path carrying a
    // real first name, and the first two are the anonymised form this gate asks for while the third
    // is the leak. A lookahead that knows four placeholders and not the fifth flags the cure, so the
    // moved OUT of the regex and into `PATH_PLACEHOLDERS`, checked against the CAPTURE below — one
    // place to add a word, and the same shape `HANDLE_PLACEHOLDERS` already uses for handles.
    re: /\/Users\/(?!<|\.\.\.)([A-Za-z][A-Za-z0-9._-]{1,31})\//g,
    why: 'a real account name in a home-directory path identifies the machine\'s owner',
  },
  {
    id: 'email-address',
    // A real-looking address. The documented example domains are how you write one safely.
    // The local part may be a placeholder (`name@`, `user@`, `you@`, `someone@`) and the domain may
    // be any documented example domain, including a subdomain of one (`northwind.example.com` is how
    // the prompt docs write a fictional company).
    //
    // ⚠ THE RESERVED TLDs ARE EXEMPT, AND THAT IS NOT A LOOSENING (lane t101). `.test`, `.example`,
    // `.invalid` and `.localhost` are reserved BY THE IETF for exactly this purpose — RFC 2606 §2
    // and RFC 6761 — so `a.person@somewhere.test` cannot be anybody's inbox by construction, the way
    // the same local part on a LIVE top-level domain can. Widening the corpus to tests put ~40 of
    // the reserved form beside four real addresses; a gate that cannot tell the standard from the
    // leak buries the leak. (The counter-instance belongs in the fenced fixture table below, not
    // in this note — this gate reads its own comments, and it caught this paragraph writing one.)
    // The four real ones are the finding, and they are scrubbed; the reserved ones are
    // the shape this gate should be ASKING for, and `@ex.com`/`@ms.com`-style abbreviations of a
    // live TLD were rewritten to `.test` rather than exempted, because they are not reserved.
    re: /\b(?!name@|user@|you@|someone@|anyone@|noreply@|no-reply@)[A-Za-z0-9._%+-]+@(?![A-Za-z0-9.-]*example\.(?:com|org|net)\b|[A-Za-z0-9.-]*\.(?:test|example|invalid|localhost)\b|x\.com\b|org\.com\b|odata\.bind\b|icloud\.com\b|anthropic\.com\b|domain\.com\b|email\.com\b|company\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi,
    // ⚠ CASE-INSENSITIVE, and it was not (lane t101): a fixture wrote `Pat@Example.com` and the
    // lowercase exemption did not see `Example.com`, so the documented example domain — the one
    // right answer — was reported as somebody's inbox. Every character class here already spans
    // both cases, so the flag only fixes the exemptions.
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
    // ⚠ A SUBDOMAIN IS NOT AN ACCOUNT PATH (lane t101): the corpus widening surfaced
    // `https://docs.github.com/rest` in a test, read as the account `rest`, because `github.com/`
    // matches inside `docs.github.com/`. `docs.`, `api.`, `raw.` and `gist.` are GitHub's own
    // service hosts and what follows them is a document path, never a person. The negative
    // lookbehind for a dot is the whole fix, and it is cheaper than naming every subdomain.
    re: /(?:(?<![A-Za-z0-9.-])github\.com\/(?![A-Za-z0-9-]+\/[A-Za-z0-9._-])|github\s+(?:user|handle|account)\s+[`'"])([A-Za-z][A-Za-z0-9-]{2,38})\b/gi,
    why: 'a personal account handle is identifying; the product\'s own public slug is exempted',
  },
  {
    id: 'logic-keyed-on-a-name',
    /**
     * ── D3: NOTHING MAY RELY ON A SPECIFIC NAME ──────────────────────────────────────────
     *
     * The owner's rule has two halves and this gate only ever enforced one. "No names in anything
     * that goes live" is the half about LEAKS; "nothing about your code should be reliant on any
     * specific agent names" is the half about BEHAVIOUR, and a scrub cannot see it: deleting the
     * name from `if (agent.name === 'Zargo')` and leaving the comparison is not a fix, it is a
     * rename. The 2026-09-26 audit found four such sites and routed all four through
     * `config/platform.ts` accessors (`primaryAgentId()`, `ownerName()`, …) so the code asks the
     * configuration who somebody is instead of recognising a word. Nothing re-grew them — this
     * clause is what says so on every run instead of once.
     *
     * IT IS A SHAPE, NOT A NAME LIST, so it reds on a literal nobody has thought of yet and it
     * works on a box with no database.
     *
     * ⚠ THE OBVIOUS PATTERN IS USELESS AND WAS MEASURED BEFORE BEING DISCARDED: `name === '<word>'`
     * matches 218 sites in this tree and every one of them is legitimate — tool names
     * (`name === 'send_to_agent'`), mail headers (`h.name === 'Subject'`), DOM error names
     * (`e.name === 'AbortError'`), directory entries (`entry.name === 'data'`). A clause with 218
     * false positives is a clause somebody deletes. TWO conjuncts make it precise:
     *   (1) the expression must name a PERSON OR AGENT — `agentName`, `agent.name`, `owner_name`,
     *       `assigneeName`, `creator.name` — not a tool, a header, a file or an error;
     *   (2) the literal must be a DISPLAY NAME: one capitalised word. Tool and header names are
     *       snake_case or multi-capital (`Message-ID`, `AbortError`), and both fail this.
     * Role names are then subtracted at match time from `config/platform.ts`'s own defaults, because
     * `agent.name === 'Healer'` recognises a product ROLE, which is vocabulary and not a person —
     * the same subtraction the roster half already makes, read from the same place.
     *
     * COMMENTS ARE STRIPPED BEFORE THIS ONE RUNS, and only this one (see `runPatterns`). Every other
     * pattern here exists BECAUSE comments ship. This clause is about what the code DOES, and
     * `tools/index-notes.ts` carries a note that quotes the audit's old `row?.name === 'Dreamer'`
     * shape to record that it was removed — a clause that fires on that note tests the prose.
     */
    re: /\b(?:agent|owner|primary|pm|trainer|healer|dreamer|imaginer|assignee|creator|counterparty|person|people|contact|user)\w*(?:\.|_|->)?(?:name|Name)\b\s*(?:===|!==|==|!=)\s*['"`]([A-Z][A-Za-z]{2,30})['"`]/g,
    why: 'logic that recognises an agent or a person by NAME breaks the day it is renamed; ask '
      + '`config/platform.ts` who somebody is instead',
    codeOnly: true,
    roleAware: true,
  },
];

// ── THE FIXTURE TABLE — the census-reader law: caught AND ignored, both proven ──
// BEGIN NAMES-GATE TEST CORPUS  (the pattern half skips to the closing sentinel; see CORPUS_FENCE)
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
  // ⚠ THESE TWO ROWS USED TO END `.test` AND THAT WAS WRONG (lane t101), stated rather than quietly
  // swapped: `.test` is RESERVED by RFC 2606 §2 and can never resolve to anybody's inbox, so a
  // fixture asserting it IS a leak was asserting the opposite of the truth. They now carry a live
  // TLD, which is what makes an address somebody's; the reserved forms moved to the ignore rows
  // below. The local parts stay synthetic, per this table's one rule.
  ['await sendMail("a.person@somewhere.net")', 'email-address'],
  ['// reply-to: another.person@corp.io in the header', 'email-address'],
  ['// a placeholder local part is not an inbox: someone@corp.io', null],
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

  // ── lane t101: the placeholder list that moved out of the home-path lookahead ──
  ['// the anonymised form this gate asks for: /Users/someone/.nvm/bin/node', null],
  ['const HOME = \'/Users/a-user/.dojo/uploads\';', null],
  ['// the leak the placeholders sat beside: /Users/qwertyuser/taxes.pdf', 'home-path-username'],

  // ── lane t101: the IETF's reserved TLDs (RFC 2606 §2, RFC 6761) are how a test writes an inbox ──
  ['// reserved, cannot be anybody: a.person@somewhere.test', null],
  ['{ email: \'owner@outlook.example\' }', null],
  ['// reserved: thing@host.invalid and thing@host.localhost', null],
  ['// a LIVE tld is not reserved, whoever short the label: a.person@somewhere.co', 'email-address'],

  // ── lane t101: a GitHub SUBDOMAIN is a document host, not an account path ──
  ['// the REST docs: (https://docs.github.com/rest)', null],
  ['// the releases API: https://api.github.com/repos/someorg/their-tool/releases', null],
  ['// an account page on the real host is still an account: github.com/someperson', 'personal-github-handle'],

  // ── lane t101, D3: logic that RECOGNISES somebody by name, and the 218 shapes that must not fire ──
  ["if (agent.name === 'Zergblatt') return true;", 'logic-keyed-on-a-name'],
  ['if (ownerName === "Qwertyuser") skip();', 'logic-keyed-on-a-name'],
  ["const isIt = assigneeName !== 'Zergo';", 'logic-keyed-on-a-name'],
  // A ROLE is product vocabulary, read from `config/platform.ts`'s defaults, so it is not a person:
  ["if (row?.name === 'Healer') return healerId();", null],
  ["if (agent.name === 'Dreamer') return dreamerId();", null],
  // The shapes that made the loose version unusable — a tool, a header, an error, a directory entry:
  ["if (name === 'send_to_agent') return true;", null],
  ["const from = headers.find(h => h.name === 'From')?.value;", null],
  ["if (e.name === 'AbortError') return true;", null],
  ["if (entry.name === 'data') continue;", null],
  ["if (providerName === 'System') return null;", null],
  ["if (toolName === 'file_delete') return 'file deletion';", null],
  // snake_case and multi-capital literals are identifiers, never display names:
  ["if (agent_name === 'primary_agent') return true;", null],
  ["if (agentName === 'Message-ID') return true;", null],
  // ⚠ A COMMENT QUOTING THE OLD SHAPE IS A RECORD OF ITS REMOVAL, and `tools/index-notes.ts` keeps
  // one. This row is why the census clause strips comments and the other patterns do not.
  ["// the audit's own shape, recorded as removed: read `row?.name === 'Zergo'` until 2026-09-26", null],
];

/**
 * THE ROSTER HALF'S OWN TABLES, and they live HERE — inside the fence — rather than inside
 * `selfTest()` where they were written (lane t101 fix round). The review that caught this is the
 * argument: they are FIXTURE DATA holding deliberate name instances, and while they sat in the body
 * of a function the only way to stop the gate reporting them was to exempt THE WHOLE FILE from the
 * roster half. That exemption then hid three live roster names in this file's own doctrine —
 * including one this lane itself introduced. Fixture data belongs in the fenced block; code and
 * doctrine belong outside it and must be scannable. Nothing else gets to be unscannable.
 */
/** A roster name matches as a WHOLE WORD only, or every vendor identifier containing one is a false alarm. */
const FIX_WORD_ONLY = [
  ['// the harness bot ran it', 'Behavior', false],
  ['// Zergblatt ran it', 'Zergblatt', true],
  ['    am_michael: { language: \'en-us\' },', 'Michael', false],
  ['// asked Michael about it', 'Michael', true],
  ['const marbles = true;', 'Arble', false],
];
/** Review M1's second shape: an agent name written LOWERCASE as DATA — quoted only, which is what
 *  separates `createdBy: '<a name>'` from a vendor voice id or a colliding English word. */
const FIX_QUOTED_LOWER = [
  ["    { serviceName: 'mailvendor', createdBy: 'zergo', createdOn: '2026-06-21' },", 'Zergo', true],
  ["const owner = \"zergo\";", 'Zergo', true],
  ['const owner = `zergo`;', 'Zergo', true],
  ["// prose about zergo outside any quotes", 'Zergo', false],
  ["const zergoCount = 1;   // an identifier, not data", 'Zergo', false],
  ["// a quote that spans no name: 'the primary agent'", 'Zergo', false],
  ["  am_michael: { language: 'en-us' },", 'Michael', false],
  ["  { voice: 'am_michael' },", 'Michael', false],
];
/** Lane t101: a name written straight after a literal `\n` escape, counted BOTH ways — found through
 *  the escape, and never conjured where the needle is genuinely part of a longer word. */
const FIX_THROUGH_ESCAPE = [
  ["'You are A, the PM. Escalate to B.\\nZergblatt does not have iMessage.'", 'Zergblatt', true],
  ["'# Zergo\\n\\nYou are Zergo.'", 'Zergo', true],
  ["'line one\\tZergo owns it'", 'Zergo', true],
  ["'nothing here but prose\\nand more prose'", 'Zergo', false],
  ['const zergoCount = 1;', 'Zergo', false],
  ['// marbles are not an agent', 'Arble', false],
];
/**
 * THE FIXTURE ROSTER (t111-C3) — three INVENTED names, standing in for a live roster on any box
 * that has no database: CI, and every machine that has never run the platform.
 *
 * It is declared in here because fixture data belongs in the fence and nowhere else: this file is
 * a scanned surface, the roster half reads prose, and a name written outside these sentinels is
 * found by the machinery it exists to drive. The file's own doctrine says so a few hundred lines
 * up, having learned it the hard way — exempting the WHOLE file instead then hid three live names
 * in this gate's own commentary.
 *
 * Each was measured to have ZERO occurrences in the repository outside this block, so a hit is a
 * real regression and never this fixture finding itself. The live roster still WINS wherever a
 * database exists; this only replaces measuring NOTHING with measuring something.
 */
const FIXTURE_ROSTER = ['Vexworth', 'Plimbrey', 'Thassick'];

/** The roster PIPELINE's fixture table: a line, the fixture name, and whether it must match. */
const FIX_ROSTER_PIPELINE = [
  ['Vexworth', 'const createdBy = "Vexworth";', true,  'a fixture name IS matched'],
  ['Plimbrey', '// Plimbrey asked about it',    true,  'in a comment too — this half reads prose'],
  ['Thassick', 'const thassickCount = 1;',      false, 'an identifier is not a name (whole-word, case-sensitive)'],
  ['Vexworth', 'const x = vexworthing;',        false, 'nor a longer word containing it'],
];

/** The FILTERS' fixture table, both directions. A function because one row needs a role name. */
const FIX_NEEDLE_FILTERS = (roles) => [
  [['Vexworth', 'Plimbrey', 'Thassick'], 3, 'three valid names make three needles'],
  [['Vo'], 0, 'a 2-character name is filtered out'],
  [['Vex worth!'], 0, 'a name outside the allowed charset is filtered out'],
  [[...roles].slice(0, 1), 0, 'a ROLE name is never a roster needle'],
];

// END NAMES-GATE TEST CORPUS

/**
 * Strip `//` and `/* *\/` comments. Used ONLY by `codeOnly` patterns — the census clause (D3), whose
 * subject is what the code DOES. Every other pattern in this file deliberately reads comments,
 * because `tsconfig.base.json` does not set `removeComments` and a comment is a shipped byte.
 * String-aware enough for this job: a `//` inside a quoted string does not open a comment.
 */
/**
 * A literal `\n` in a source string is two characters, and `n` is a word character — so a
 * whole-word needle finds no boundary before a name written straight after one. Souls, prompts and
 * assertion fixtures are all one-line strings with escaped newlines, which is where this bites.
 * Normalising the escape to a space before matching is the fix; a space cannot complete an address,
 * a path or a handle, so it invents nothing, and the substitution is length-preserving-enough that
 * per-line reporting is unaffected (the RAW line is what gets printed).
 */
function unescapeForMatching(line) {
  return line.replace(/\\[nrtfv]/g, ' ');
}

function stripComments(text) {
  let out = '', i = 0, quote = null, inRegex = false;
  // ⚠ REGEX LITERALS MUST BE TRACKED, and the first cut did not: this very file is mostly patterns,
  // and `/['"`][^'"`\n]*/` contains three quote characters. A stripper that reads the first of them
  // as opening a string desynchronises for the rest of the file — every `//` and `/*` after it then
  // looks like string content, so NOTHING gets stripped and the census clause reads the doctrine
  // above it as code. It fired on this file's own explanation of itself, which is how it was caught.
  // `prev` is the standard disambiguator: after a value (identifier, `)`, `]`, literal) a `/` is
  // division; after an operator, a comma, a brace or the start of input it opens a regex.
  const DIVIDES_AFTER = /[A-Za-z0-9_$)\]'"`]$/;
  while (i < text.length) {
    const c = text[i], c2 = text[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (inRegex) {
      if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue; }
      if (c === '[') { // a character class may hold an unescaped `/`
        while (i < text.length && text[i] !== ']') { if (text[i] === '\\') { out += text[i]; i++; } out += text[i]; i++; }
        out += text[i] ?? ''; i++; continue;
      }
      if (c === '/' || c === '\n') inRegex = false;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && c2 === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '/' && !DIVIDES_AFTER.test(out.replace(/\s+$/, ''))) { inRegex = true; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/**
 * `codeText` is the same text with comments already removed. It is a PARAMETER rather than computed
 * here because the scan runs line by line, and a `/**` block comment's inner lines carry no opener —
 * stripping them one at a time would leave every line of this file's own doctrine looking like code.
 * The caller strips the whole file once (newlines preserved, so line numbers still line up).
 */
function runPatterns(text, codeText) {
  const hits = [];
  for (const p of PATTERNS) {
    const subject = p.codeOnly ? (codeText ?? stripComments(text)) : text;
    p.re.lastIndex = 0;
    for (const m of subject.matchAll(p.re)) {
      if (p.roleAware) {
        // `agent.name === 'Healer'` recognises a product ROLE, which is vocabulary and not a
        // person. The role list is read from `config/platform.ts`'s own defaults, so a renamed role
        // cannot turn this clause into a false alarm and a NEW role is covered the day it lands.
        if (roleNames().has((m[1] ?? '').toLowerCase())) continue;
      }
      if (p.id === 'home-path-username') {
        const got = (m[1] ?? '').toLowerCase();
        if (PATH_PLACEHOLDERS.has(got) || got.startsWith('<')) continue;
      }
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
    const hits = runPatterns(text, stripComments(text));
    const got = hits.length ? hits[0].id : null;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${String(got ?? 'ignored').padEnd(24)} want ${String(want ?? 'ignored').padEnd(24)} ${text.slice(0, 62)}`);
  }
  console.log('── an agent name written lowercase as DATA (quoted only) ──');
  for (const [line, name, want] of FIX_QUOTED_LOWER) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const got = new RegExp(`['\"\`][^'\"\`\n]*\\b${esc}\\b[^'\"\`\n]*['\"\`]`, 'i').test(line);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${String(got).padEnd(5)} want ${String(want).padEnd(5)} "${name}" in ${line.trim().slice(0, 52)}`);
  }
  console.log('── a name after a literal \\n escape is still a name (whole-word would miss it) ──');
  for (const [line, name, want] of FIX_THROUGH_ESCAPE) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const got = new RegExp(`\\b${esc}\\b`, 'i').test(unescapeForMatching(line));
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${String(got).padEnd(5)} want ${String(want).padEnd(5)} "${name}" in ${line.trim().slice(0, 52)}`);
  }
  // ── THE ROSTER PIPELINE ITSELF, DRIVEN END TO END (t111-C3) ──────────────────────────
  // The tables below prove the SHAPE of a needle with their own inline regexes. This block
  // proves the machinery THE SCAN RUNS: `rosterNeedlesFrom` → `rosterNeedleFor` → match, with
  // the two filters in place. Before this, that pipeline had only ever executed on a box with a
  // database, because without one the roster was empty and there was nothing to drive.
  console.log('── the roster needle pipeline, end to end on the fictional fixture roster ──');
  const fixtureNeedles = rosterNeedlesFrom(FIXTURE_ROSTER, roles);
  for (const [name, line, want, why] of FIX_ROSTER_PIPELINE) {
    const needle = fixtureNeedles.find((x) => x.name === name);
    const got = !!needle && needle.re.test(line);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${String(got).padEnd(5)} want ${String(want).padEnd(5)} ${why}`);
  }
  // BOTH DIRECTIONS on the filters: a 2-character name and a role name must NOT become needles,
  // or the gate flags every occurrence of a short common word.
  for (const [names, wantCount, why] of FIX_NEEDLE_FILTERS(roles)) {
    const got = rosterNeedlesFrom(names, roles).length;
    const ok = got === wantCount;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${String(got).padEnd(5)} want ${String(wantCount).padEnd(5)} ${why}`);
  }
  // ⚠ G1: THE COMMITTED ROSTER MUST STAY FICTIONAL, and the gate refuses rather than trusts a
  // comment. Checked against the halves that know real identities on a box that has them — so on
  // a developer box this clause compares the fixture against the LIVE roster and the owner's own
  // name, and a collision is a RED rather than a silent, permanently-passing needle.
  const realIdentities = new Set([
    ...(roster.source === 'fixture' ? [] : roster.names),
    ...owner.names,
  ].map((n) => n.toLowerCase()));
  for (const fixture of FIXTURE_ROSTER) {
    const collides = realIdentities.has(fixture.toLowerCase());
    if (collides) bad++;
    console.log(`  ${collides ? '✗' : '✓'} ${fixture} is not a real identity on this box`);
  }

  console.log('── roster matching is whole-word, so vendor identifiers are not names ──');
  for (const [line, name, want] of FIX_WORD_ONLY) {
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
const owner = ownerNames();
const handles = derivedIdentities();
const agentIds = liveAgentIds();
const files = scannedFiles();

const selfTestBad = selfTest();
if (selfTestBad > 0) {
  console.error(`\n✗ names gate: its OWN fixture table has ${selfTestBad} failure(s). A matcher that `
    + 'cannot pass its own table cannot be trusted to read the tree.');
  process.exit(1);
}
if (process.argv.includes('--self-test')) process.exit(0);

// Roster names worth scanning for: whole words, at least 3 characters, and never a role name.
const rosterNeedles = rosterNeedlesFrom(roster.names, roles);

/**
 * The owner's own name, needled exactly like a roster name (lane t101, half 1c). Whole-word and
 * case-SENSITIVE for the bare pass, case-insensitive inside quotes — the same two passes, for the
 * same reason: `setConfig('owner_name', '<name>')` is a display name written as DATA, which is the
 * shape the reviewers actually found, while a lowercase bare word may be an ordinary English one.
 */
const ownerNeedles = owner.names.map((n) => {
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    name: n,
    re: new RegExp(`\\b${esc}\\b`),
    lower: new RegExp(`['"\`][^'"\`\n]*\\b${esc}\\b[^'"\`\n]*['"\`]`, 'i'),
  };
});

const findings = [];
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  // Comments stripped ONCE per file, newlines preserved, so `codeLines[i]` is still line i + 1.
  const codeLines = stripComments(text).split('\n');
  const rosterExempt = ROSTER_EXEMPT_FILES.has(rel);
  // The one corpus exemption (D5): inside this file's sentinel-delimited fixture table, a shape is
  // the test rather than the defect. Pattern half only, and only between the two sentinels.
  const fenced = rel === CORPUS_FENCE.file
    ? (() => {
        const o = lines.findIndex((l) => l.includes(CORPUS_FENCE.open));
        const c = lines.findIndex((l) => l.includes(CORPUS_FENCE.close));
        if (o < 0 || c < 0 || c < o) {
          console.error(`✗ names gate: ${CORPUS_FENCE.file} has lost its corpus sentinels `
            + `("${CORPUS_FENCE.open}" / "${CORPUS_FENCE.close}"). The fixture table is the one place `
            + 'a shape is allowed to be an instance, and a fence that cannot be found silently '
            + 'either blinds the gate or reports its own test suite.');
          process.exit(1);
        }
        return { from: o, to: c };
      })()
    : null;
  lines.forEach((rawLine, i) => {
    // The fenced corpus is skipped by EVERY half, and it is the ONLY thing skipped in this file.
    if (fenced && i >= fenced.from && i <= fenced.to) return;
    // ⚠ A LITERAL `\n` IN A STRING HIDES THE NAME AFTER IT, and this gate had the blind spot it was
    // built to close (lane t101, found by a test that counts renames rather than by the gate).
    // Souls, prompts and assertion fixtures are written as one-line strings with escaped newlines:
    //     'You are <a name>, the project manager. Escalate to <a name>.\nZergblatt has no iMessage.'
    // Every needle here is WHOLE-WORD, and in the FILE those four characters are `.`, `\`, `n`, `Z` —
    // so `n` and `Z` are both word characters and `\b` finds NO boundary before the name. The name
    // rides green, and so does a scrub that uses the same whole-word rule. Normalising the escape to
    // a space before matching is the whole fix; it cannot invent a hit (a space never completes an
    // address, a path or a handle) and the line number is untouched because this is per line.
    const line = unescapeForMatching(rawLine);
    if (!rosterExempt) for (const { name, re, lower } of rosterNeedles) {
      if (re.test(line)) findings.push({ rel, line: i + 1, kind: 'agent-name', detail: name, text: rawLine.trim() });
      // ⚠ THE LOWERCASE PASS, and review M1 is why it exists: the roster match is case-SENSITIVE, so a
      // lowercase vendor voice id is not the agent named after it — and that let the audit's own worst
      // finding ride green, because `createdBy: '<a roster name, lowercased>'` is the roster name in a
      // LIVE STRING LITERAL. FIX_QUOTED_LOWER carries the instances; this note does not.
      // Case-insensitivity is therefore restricted to QUOTED strings: an agent id written as data is
      // the shape that shipped, while a bare lowercase identifier stays exempt.
      else if (lower.test(line)) findings.push({ rel, line: i + 1, kind: 'agent-name-in-string', detail: name, text: rawLine.trim() });
    }
    for (const id of agentIds) {
      if (line.includes(id)) findings.push({ rel, line: i + 1, kind: 'live-agent-id', detail: id, text: rawLine.trim() });
    }
    for (const h of handles) {
      if (new RegExp(`\\b${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(line)) {
        findings.push({ rel, line: i + 1, kind: 'derived-identity', detail: h, text: rawLine.trim() });
      }
    }
    for (const { name, re, lower } of ownerNeedles) {
      if (re.test(line)) findings.push({ rel, line: i + 1, kind: 'owner-name', detail: name, text: rawLine.trim() });
      else if (lower.test(line)) findings.push({ rel, line: i + 1, kind: 'owner-name-in-string', detail: name, text: rawLine.trim() });
    }
    for (const h of runPatterns(line, codeLines[i] ?? '')) {
      findings.push({ rel, line: i + 1, kind: h.id, detail: h.captured ?? h.match, text: rawLine.trim() });
    }
  });
}

// ── THE REPORT. It names the FILE and the LINE; it prints the offending token only as a length and
// a class, because this gate's own output is pasted into commit messages and issues.
console.log(`\n── scanned ${files.length} file(s): what reaches a user's disk AND what reaches the `
  + 'public repository (tests, deploy/checks, the pin files) ──');
console.log(`  identities derived at check time: ${handles.length} handle(s) (github_account.login + git `
  + `config, product org/repo subtracted), ${agentIds.length} live agent id(s)`
  + (handles.length === 0 ? ' — ⚠ NO handle derivable on this box, so the structural '
    + '`github-handle-beside-our-org` shape is the only handle cover here' : ''));
console.log(roster.available
  ? `  roster: ${rosterNeedles.length} live agent name(s) read from the database at check time `
    + `(${roster.names.length} agent row(s) total; role names excluded, nothing written to this file)`
  : `  ⚠ roster half ran on the FICTIONAL FIXTURE ROSTER (${rosterNeedles.length} needle(s)) — no `
    + `database at ${roster.dbPath}, so there is no live roster to read. The matching machinery `
    + 'DID run and its self-test drove it end to end, which is what makes this half meaningful in '
    + 'CI at all. But it checked invented names: a real agent name on this box, if there were one, '
    + 'was NOT checked, so this is not the same assurance as a run on a box with a database.');
console.log(owner.available
  ? `  owner half: ${ownerNeedles.length} name(s) read from config.owner_name at check time `
    + '(the product fallback and the anonymising placeholders subtracted; nothing written down)'
  : '  ⚠ owner half SKIPPED — no database to read `config.owner_name` from. This is the half that '
    + 'catches a fixture seeding the owner\'s own first name, and a skip is not a pass.');



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
    const kind = f.kind === 'agent-name' ? 'agent name' : f.kind === 'owner-name' ? 'owner name' : f.kind;
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

// ── THE WORKSPACE STAYS OUT OF THE PUBLIC REPO (2026-09-27) ──────────────────
// Worker reports under .superpowers/ quote dev-box agent names and live details
// BY DESIGN; the repo is public. 25 tracked reports were untracked the day this
// clause landed. A future `git add -f` re-tracks silently — this makes it loud.
{
  const tracked = execFileSync('git', ['ls-files', '.superpowers'], { encoding: 'utf8' }).trim();
  if (tracked) {
    console.error('✗ tracked files under .superpowers/ — the session workspace is public-repo-visible:');
    for (const f of tracked.split('\n').slice(0, 5)) console.error('    ' + f);
    process.exitCode = 1;
  }
}

process.exit(1);
