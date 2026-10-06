// t113 A2 — THE THREAD TOKEN ASKS SQL THE SAME QUESTION IT ASKS JAVASCRIPT.
//
// ── THE DEFECT, AND WHY IT RAN IN BOTH DIRECTIONS AT ONCE ──
//
// A marker carries eight characters of a thread id. Three readers had to decide "does this
// token identify that stored FULL id?", and all three answered it by hand. Re-derived at this
// head before anything moved (G11), by reading:
//
//   agent/a2a-replies.ts:229          `match[2] !== threadShort`  (threadShort = id.slice(0,8))
//   agent/a2a-replies.ts:294          `substr(thread_id, 1, 8) = ?`
//   agent/v2/outbound-ledger.ts:231   `substr(thread_id, 1, 8) = ?`
//
// All three are the LEGACY front slice. For an id `makeThreadId` mints — `thread-<hash>-<seed>`
// — the front eight characters are `thread-` plus ONE hash character: about 36 buckets across
// every named thread on the box. So the slice was a false-POSITIVE magnet (collision class
// FA-C2, already fixed in the authoritative queries sitting directly above these three). Then
// t109 moved the PRODUCER to the varying region, and the same three comparisons became false
// NEGATIVES for every marker written since — a current token never equals the front slice of a
// named id. The cost of the negative is a dropped nudge: the enforcer asks "did this agent
// already reply on this thread?", gets `false` where the truth is `true`, and says the wrong
// thing to the agent.
//
// t109 handed up the one-line fix and named `a2aThreadTokenMatches` as the one answer. Two of
// the three sites are SQL and cannot call a JS function, so `@dojo/shared` now carries the SQL
// twin, `a2aThreadTokenMatchesSql`, beside the JS one. A twin is only ONE answer for as long as
// the two halves agree, and §1 is what holds them together.
//
// Two further sites of the same hand-rolled shape turned up in this lane's own census.
// `a2a-replies.ts:164`'s `threadId.slice(0, 8)` — the key for the genuinely-short legacy row
// query — is fixed here, byte-identically, as `a2aThreadShortLegacy(threadId)`: named, so a
// reader can tell WHICH era's token the line means. `a2a-transport.ts:1770`'s second `IN`
// member is the same shape and is HANDED UP, not fixed: the live lane `t114-flat-timers` holds
// that file and a rehearsed `git merge-tree` CONFLICTED on the shared import line. Nothing is
// wrong there today — both `IN` members are exact, never prefixes — see the clause below.
//
// ── UNITS ──
//
// §1's unit is (token, stored id) PAIRS: the full cross product of 7 tokens x 8 stored ids = 56
// pairs, run through both forms and compared pair for pair. It is not a sample — the ids cover
// every structural case the two implementations can disagree on (prefixed, unprefixed, shorter
// than eight, exactly eight, prefix-only, prefix-doubled, and two named ids whose front slices
// COLLIDE while their current tokens do not).
//
// §4's unit is FILES scanned for the SQL predicate.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
  a2aThreadShort,
  a2aThreadShortLegacy,
  a2aThreadTokenMatches,
  a2aThreadTokenMatchesSql,
} from '@dojo/shared';

const SRC = path.join(__dirname, '..', '..');

/** Comments blanked, length kept, so prose about a query is never read as the query (G4). */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

const read = (rel: string): string => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));

/**
 * A front slice of a thread-id column, in SQL — the defect class in the position where it
 * BITES: a query predicate. Unambiguous, which is why §4 is a SQL census and not a JS one.
 *
 * ⚠ A `.slice(0, 8)` in JavaScript cannot be judged by its shape. Seven live sites truncate a
 * thread id for DISPLAY — six interpolate it into model-facing text (`agent/tools/cat/agents.ts`,
 * `agent/a2a-transport.ts`) and one fills a log meta field (`tracker/tools.ts`'s Key-1 close
 * line) — and a tree-wide ban on those would be enforcing something nobody wrote. So the JS
 * half is pinned per MODULE in §3, by absence, over the modules that had the defect; the
 * tree-wide half is this. Stated plainly because it is a real boundary: a NEW module that keys
 * a lookup on a JS front slice is caught here only if it does so in SQL.
 */
const FRONT_SLICE_SQL = /substr\(\s*(?:\w+\.)?(?:thread_id|a2a_thread_id)\s*,\s*1\s*,\s*8\s*\)/;

const walkSrc = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walkSrc(p);
  return e.isFile() && p.endsWith('.ts') ? [p] : [];
});

// ── THE STORED IDS. Every structural case, not a sample. ──
// The two named ids are the point of the exercise: they share their front EIGHT characters
// (`thread-a`) and differ in the varying region — exactly the pair the front slice could not
// tell apart and the current token can.
const NAMED_A = 'thread-a1b2c3d4-first';
const NAMED_B = 'thread-a9z8y7x6-second';
const STORED = [
  NAMED_A,
  NAMED_B,
  'thread-',                                  // the prefix and nothing else
  '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',     // a plain UUID id: both forms are equal
  'abcdefgh',                                 // exactly 8 — a genuinely-short legacy row
  'short',                                    // shorter than 8
  'threadxyz-not-prefixed',                   // close to the prefix but not it
  'thread-thread-doubled',                    // the prefix twice: a `replace()` form would differ
];

const TOKENS = [
  a2aThreadShort(NAMED_A),           // the current form of a named id
  a2aThreadShortLegacy(NAMED_A),     // its pre-t109 form, which collides with NAMED_B's
  a2aThreadShort(NAMED_B),
  a2aThreadShort('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'),
  'abcdefgh',
  'thread-t',                        // the collision bucket itself
  'zzzzzzzz',                        // matches nothing
];

describe('the thread token asks SQL the same question it asks JavaScript', () => {
  // ── §1 THE EQUIVALENCE. Why the twin is one answer and not two. ──
  it('the SQL twin and the JS matcher agree on every (token, stored id) pair', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE rows (thread_id TEXT)');
    const ins = db.prepare('INSERT INTO rows (thread_id) VALUES (?)');
    for (const id of STORED) ins.run(id);

    const sql = db.prepare(`SELECT thread_id FROM rows WHERE ${a2aThreadTokenMatchesSql('thread_id')}`);

    const disagreements: string[] = [];
    let pairs = 0;
    for (const token of TOKENS) {
      const hits = new Set((sql.all(token, token) as Array<{ thread_id: string }>).map((r) => r.thread_id));
      for (const id of STORED) {
        pairs++;
        const js = a2aThreadTokenMatches(token, id);
        const inSql = hits.has(id);
        if (js !== inSql) disagreements.push(`token=${token} id=${id}: js=${js} sql=${inSql}`);
      }
    }
    db.close();
    expect(disagreements).toEqual([]);
    expect(pairs, 'the cross product is the whole cross product').toBe(56);
  });

  // ── §2 THE BEHAVIOUR THE FIX BUYS, as behaviour and not as agreement ──
  // §1 alone would stay green if BOTH forms regressed to the front slice together. These say
  // what the reader must now resolve, and what it must still refuse.
  it('a CURRENT token resolves its named thread — the false negative t109 created', () => {
    const current = a2aThreadShort(NAMED_A);
    expect(current, 'the token comes off the varying region').toBe('a1b2c3d4');
    // the old predicate written out, so the regression is visible rather than described
    expect(NAMED_A.slice(0, 8) === current, 'the bare front slice does NOT answer it').toBe(false);
    expect(a2aThreadTokenMatches(current, NAMED_A)).toBe(true);
  });

  it('a LEGACY token still resolves, carrying exactly the information it always did', () => {
    const legacy = a2aThreadShortLegacy(NAMED_A);
    expect(legacy).toBe('thread-a');
    expect(a2aThreadTokenMatches(legacy, NAMED_A), 'history keeps working').toBe(true);
    expect(a2aThreadTokenMatches(legacy, NAMED_B), 'and is no more precise than it ever was').toBe(true);
  });

  it('a current token is precise where the legacy one was not', () => {
    expect(a2aThreadTokenMatches(a2aThreadShort(NAMED_A), NAMED_B)).toBe(false);
    expect(a2aThreadTokenMatches(a2aThreadShort(NAMED_B), NAMED_A)).toBe(false);
  });

  it('and the leading prefix is stripped ONCE, not everywhere', () => {
    // a `replace(id, 'thread-', '')` spelling of the twin would strip both occurrences and
    // answer a different question; the CASE/substr form strips the leading one only, which is
    // what the JS `/^thread-/` anchor does
    expect(a2aThreadShort('thread-thread-doubled')).toBe('thread-d');
  });

  // ── §3 THE WIRE: the sites ASK through the one home ──
  // Presence of an import proves nothing. These assert the call SHAPE and its APPLICATION over
  // comment-stripped source, AND that the hand-rolled predicate is gone (G4, both directions).
  it('a2a-replies.ts routes the prose fallback and the legacy query through the shared forms', () => {
    const src = read('agent/a2a-replies.ts');
    expect(src, 'the prose comparison is the shared matcher, applied')
      .toMatch(/if\s*\(\s*!a2aThreadTokenMatches\(\s*match\[2\]\s*,\s*threadId\s*\)\s*\)\s*continue\s*;/);
    expect(src, 'and the hand-rolled comparison is gone')
      .not.toMatch(/match\[2\]\s*!==\s*threadShort/);
    expect(src, 'the legacy query is the shared SQL twin, interpolated into the predicate')
      .toMatch(/AND\s+\$\{a2aThreadTokenMatchesSql\('thread_id'\)\}/);
    expect(src, 'the token is bound TWICE, as the twin requires')
      .toMatch(/\.get\(agentId,\s*threadShort,\s*threadShort\)/);
    expect(src, 'the legacy-row key is NAMED rather than sliced by hand')
      .toMatch(/const threadShort = a2aThreadShortLegacy\(threadId\);/);
    expect(src, 'and no front slice survives in this module, in SQL or in JavaScript')
      .not.toMatch(/substr\(\s*(?:a2a_)?thread_id\s*,\s*1\s*,\s*8\s*\)|threadId\.slice\(\s*0\s*,\s*8\s*\)/);
  });

  it('outbound-ledger.ts does the same, and no longer slices', () => {
    const src = read('agent/v2/outbound-ledger.ts');
    expect(src).toMatch(/AND\s+\$\{a2aThreadTokenMatchesSql\('thread_id'\)\}/);
    expect(src).not.toMatch(/substr\(\s*thread_id\s*,\s*1\s*,\s*8\s*\)/);
    expect(src).toMatch(/\.get\(agentId,\s*threadShort,\s*threadShort\)/);
  });

  it('and the marker PRODUCER is still the current form — t109 B must not be undone', () => {
    // The whole false-negative half of this item exists BECAUSE the producer moved to the
    // varying region. If someone "fixes" the readers by moving the producer back, every clause
    // above goes green again while the collision class returns. So the producer is pinned here.
    expect(read('agent/a2a-transport.ts')).toMatch(/const threadShort = a2aThreadShort\(threadId\);/);
    // ⚠ HANDED UP, NOT FORGOTTEN: `findUnlandedInboundReply` (a2a-transport.ts:1770) keys its
    // second `IN` member on a hand-rolled `threadId.slice(0, 8)`. It is byte-identical in
    // behaviour to `a2aThreadShortLegacy(threadId)` and both members are EXACT, never prefixes,
    // so nothing is wrong today — only the WHICH-ERA ambiguity that let the same slice be
    // retyped in three other modules. t113 fixed it, then backed it out: branch
    // `t114-flat-timers` holds this file and a rehearsed `git merge-tree` CONFLICTED on the
    // shared `@dojo/shared` import line. Handed up rather than forced, per the campaign's
    // live-lane rule. The exact fix is in overhaul-plans/t113-report.md item A2.
  });

  // ── §4 THE CENSUS: no query in the tree asks this by hand ──
  // The both-ways half. A FOURTH query that keys on the front slice of a thread-id column reds
  // here on the day it is written, with no list to update and nothing to declare.
  it('no query in the tree keys on a hand-rolled front slice of a thread id', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const abs of walkSrc(SRC)) {
      // NOT template-masked: in this tree every query IS a template literal, so masking the
      // literals would hide the very thing being measured. Comments ARE stripped, so the prose
      // above a query describing the old predicate is not read as the predicate (G4).
      const text = stripComments(fs.readFileSync(abs, 'utf8'));
      scanned++;
      if (FRONT_SLICE_SQL.test(text)) offenders.push(path.relative(SRC, abs).split(path.sep).join('/'));
    }
    expect(offenders).toEqual([]);
    // a walk that scans nothing is green and proves nothing. A FLOOR, not a budget.
    expect(scanned, 'the walk still finds the tree').toBeGreaterThan(400);
  });

  // ── §5 THE CENSUS'S OWN CONTROLS ──
  // A census whose pattern is untested is a census that can go quiet. Each case is the exact
  // thing a reviewer would ask about.
  describe('the census itself', () => {
    it('catches the SQL front slice, qualified or bare, whitespace or none', () => {
      expect(FRONT_SLICE_SQL.test('WHERE substr(thread_id, 1, 8) = ?')).toBe(true);
      expect(FRONT_SLICE_SQL.test('WHERE substr(r.a2a_thread_id, 1, 8) = ?')).toBe(true);
      expect(FRONT_SLICE_SQL.test('WHERE substr( thread_id , 1 , 8 ) = ?')).toBe(true);
    });

    it('the twin GENERATES a front slice, and that is exactly the point', () => {
      // ⚠ READ THIS BEFORE "FIXING" §4. The twin's first arm IS `substr(thread_id, 1, 8)` —
      // markers already in the history carry the legacy token and must keep resolving. So the
      // front slice is not banned; writing it OUT BY HAND is. §4 scans SOURCE, where the twin
      // appears as a CALL, so the one hand-written copy of the slice left in the platform is
      // the one inside `a2aThreadTokenMatchesSql` in `@dojo/shared` — its one home, outside
      // this walk's corpus by construction. §3 is what pins that the two consuming modules
      // call it rather than retyping it.
      const twin = `WHERE ${a2aThreadTokenMatchesSql('thread_id')}`;
      expect(FRONT_SLICE_SQL.test(twin), 'the legacy arm is present, named and argued').toBe(true);
      expect(twin, 'and the SECOND arm is the current form, which is what was missing')
        .toMatch(/LIKE 'thread-%'/);
      expect(twin, 'and it takes the token twice').toMatch(/\?[\s\S]*\?/);
      // the census's corpus is the server tree; the twin's home is not in it
      expect(fs.existsSync(path.join(SRC, '..', '..', 'shared', 'src', 'markers.ts')), 'the home is where it says it is').toBe(true);
    });

    it('does not read PROSE about the old predicate as the old predicate', () => {
      // all three fixed sites carry a comment naming the slice they replaced; the stripper is
      // what keeps this census from failing on its own explanation
      const commented = "// the prior query OR'd in substr(thread_id, 1, 8) = ?\nconst q = 1;";
      expect(FRONT_SLICE_SQL.test(commented), 'raw text trips').toBe(true);
      expect(FRONT_SLICE_SQL.test(stripComments(commented)), 'stripped text does not').toBe(false);
    });

    it('and the stripper blanks comments without changing length', () => {
      const src = '/* a\nb */\nconst x = 1;';
      expect(stripComments(src)).toHaveLength(src.length);
    });
  });
});
