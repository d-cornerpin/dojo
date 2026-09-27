// ════════════════════════════════════════════════════════════════════════════════════════
// THE BOUNDARY TAG RIDES ONLY OLD PAIRS — the v3.2.1 round-2 red, reproduced exactly.
//
// ── THE BLAST'S EVIDENCE, transcribed ────────────────────────────────────────────────────────
//   [3] pre-repeat assembly: pair rows=3 (own=3, own+tagged=3 [must be 0], inherited+tagged=0)
//   [5] boundary: before=2026-09-27 05:28:30 after=2026-09-27 05:28:56;
//       stage1 ask at 1790486914000 (= 05:28:34); moved past the ask=true
//
// `[3]` runs BEFORE `[5]`'s reset, so at that moment the boundary was `05:28:30` and stage 1's ask
// was FOUR SECONDS INSIDE it. The report's reading is that three in-session pairs wore
// `[before this session]`, against a declared bar of 0.
//
// ── WHAT THIS FILE PINS, AND WHY IT IS A GUARD RATHER THAN A FIX ──────────────────────────────
// The predicate is `pair.askAt < boundaryMs`, and BOTH SIDES WERE MEASURED FROM THE LIVE ROWS
// before anything was written here:
//
//   `messages.created_at`         epoch-ms INTEGER (migration 131). `answeredPairsForMessages`
//                                 projects it RAW — `ask.created_at AS ask_at` — so `pair.askAt`
//                                 is a NUMBER, not a projected TEXT stamp.
//   `agents.session_started_at`   zoneless SQLite TEXT. All five writer doors build it the same
//                                 way: `now.toISOString().replace('T',' ').replace(/\.\d+Z$/,'')`
//                                 — UTC wall-clock with the `Z` DELIBERATELY STRIPPED.
//
// So the two sides are DIFFERENT FORMATS, which is this codebase's documented disease, and
// `sessionBoundaryMs` converts across it by re-appending the `Z` the writers strip. §2 is the clause
// that the conversion is real and zone-proof; §1 is the clause that an in-session pair cannot be
// tagged; §3 is the clause that a genuinely older pair still IS.
//
// ⚠ THE TIMEZONE HYPOTHESIS WAS TESTED FIRST AND IT IS NOT THE DEFECT. Measured on the exact stored
// value, through the exact shipped expression, in four zones including a 5:30 and a 8:45 offset:
// every one returned 1790487081000 — the correct UTC instant. A local misparse would have returned
// 1790512281000 (seven hours in the FUTURE on a UTC-7 box), and §2 pins that difference so a future
// edit that drops the `Z` cannot pass on a UTC runner.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-boundary-tag-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { renderRecallLane, type LaneRenderOf } from '../recall-lane.js';
import { sessionBoundaryMs, PRE_RESET_PAIR_TAG } from '../session-boundary.js';

const AGENT = 'fixture';
const CONV = 'conv-dashboard';
const db = (): Database.Database => mockDb.current!;

/** THE BLAST'S OWN INSTANTS, so the reproduction is not a paraphrase of it. */
const BOUNDARY_TEXT = '2026-09-27 05:28:30';          // [5] before=
const STAGE1_ASK_MS = 1790486914000;                  // [5] stage1 ask at … (= 05:28:34)
const OLD_ASK_MS = Date.parse('2026-09-27T05:05:33Z'); // a previous run's identical question

/** The TEXT shape every one of the five reset doors writes — `Z` stripped, on purpose. */
const doorBoundary = (ms: number): string =>
  new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

function seedPair(tag: string, askMs: number, ask: string, answer: string): string {
  const askId = `ask-${tag}`;
  const ansId = `ans-${tag}`;
  for (const [id, role, content, at] of [
    [askId, 'user', ask, askMs], [ansId, 'assistant', answer, askMs + 4000],
  ] as Array<[string, string, string, number]>) {
    db().prepare(
      `INSERT INTO messages (id, agent_id, conversation_id, role, content, created_at,
                             channel, sender_id, display_kind)
       VALUES (?, ?, ?, ?, ?, ?, 'dashboard', 'owner', ?)`,
    ).run(id, AGENT, CONV, role, content, at, role === 'user' ? 'user-text' : 'agent-text');
  }
  db().prepare('UPDATE messages SET answer_message_id = ? WHERE id = ?').run(ansId, askId);
  return askId;
}

const setBoundary = (text: string | null): void => {
  db().prepare('UPDATE agents SET session_started_at = ? WHERE id = ?').run(text, AGENT);
};

/** The lane's rendered text for a set of hits, or ''. */
function laneText(askIds: string[]): string {
  const r = renderRecallLane({
    agentId: AGENT, includeVault: false, excludeIds: new Set<string>(),
    msgHits: askIds.map((id) => ({ sourceId: id })), vaultHits: [],
    alreadyAnsweredAskIds: new Set<string>(), conversationId: CONV,
  }) as LaneRenderOf | null;
  if (!r) return '';
  return (r.messages ?? []).map((m: { content?: string }) => m.content ?? '').join('\n');
}

/**
 * One rendered pair per chunk, the way the blast's own `parsePairRows` reads them.
 *
 * ⚠ SPLIT ON `'\n- '`, NOT PER LINE, and my first cut got this wrong in a way worth keeping: a pair
 * renders as TWO lines and THE TAG RIDES THE SECOND ONE (`→ you answered …`). A per-line parser that
 * keeps only the `you were asked` line therefore reports every pair as untagged, which is a
 * false GREEN on the tag's absence and a false RED on its presence. The kit's parser splits on the
 * chunk boundary and is right; this one now matches it.
 */
const pairRows = (text: string): string[] => {
  const head = text.indexOf('Questions you have ALREADY ANSWERED');
  if (head < 0) return [];
  const rest = text.slice(head);
  const end = rest.indexOf('\n\n');
  return (end > 0 ? rest.slice(0, end) : rest).split('\n- ').slice(1);
};

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare("INSERT INTO agents (id, name, classification, status) VALUES (?, 'A', 'sensei', 'idle')").run(AGENT);
  d.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id)
     VALUES (?, ?, 'dashboard', 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE BLAST'S EXACT SHAPE. An in-session ask, a fresh boundary, and no tag.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the round-2 red, reproduced on its own instants', () => {
  it('stage 1\'s pair — ask 4s INSIDE the boundary — does NOT wear the tag', () => {
    const own = seedPair('own', STAGE1_ASK_MS,
      'Quick one: how many days are left in this month, counting today?', '5 days.');
    setBoundary(BOUNDARY_TEXT);
    // the predicate's own inputs, made visible in the failure message
    expect(sessionBoundaryMs(AGENT)).toBe(Date.parse('2026-09-27T05:28:30Z'));
    expect(STAGE1_ASK_MS).toBeGreaterThan(sessionBoundaryMs(AGENT)!);

    const text = laneText([own]);
    expect(pairRows(text)).toHaveLength(1);
    expect(text).toContain('5 days.');
    expect(text, 'an in-session pair may never wear the pre-reset tag').not.toContain(PRE_RESET_PAIR_TAG);
  });

  it('the WHOLE pre-repeat shape: one own pair and three older ones with the SAME question text', () => {
    // This is the fixture the blast actually ran against: a long-lived agent asked the same question
    // 18 times across earlier runs, in the same never-rotating conversation id. The tag must split
    // them by INSTANT, not by wording.
    const older = [1, 2, 3].map((i) =>
      seedPair(`old${i}`, OLD_ASK_MS - i * 10_000,
        'Quick one: how many days are left in this month, counting today?', '5 days.'));
    const own = seedPair('own', STAGE1_ASK_MS,
      'Quick one: how many days are left in this month, counting today?', '5 days.');
    setBoundary(BOUNDARY_TEXT);

    const rows = pairRows(laneText([own, ...older]));
    const tagged = rows.filter((l) => l.includes(PRE_RESET_PAIR_TAG));
    const untagged = rows.filter((l) => !l.includes(PRE_RESET_PAIR_TAG));
    // EXACTLY ONE untagged row, and it is the in-session one; the rest are truthfully tagged.
    expect(untagged).toHaveLength(1);
    expect(untagged[0]).toContain('10:28 PM');          // the own pair's recorded instant
    expect(tagged.length).toBeGreaterThanOrEqual(1);
    for (const t of tagged) expect(t).toContain('10:05 PM');   // every tagged row is an OLD one
    expect(rows.length).toBe(tagged.length + untagged.length);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE FORMAT SEAM, AND THE TIMEZONE TRAP, THE FR-4 WAY.
//
// The two sides of this comparison are different formats and always were. What makes the clause
// non-vacuous is the ZONE: a runner in UTC cannot tell a correct conversion from a local misparse,
// because in UTC they are the same number. So the zone is pinned by running a child process in one,
// which is the discipline `report/telemetry-coerce.ts`'s own tests established.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the boundary conversion is zone-proof', () => {
  /** `sessionBoundaryMs`'s expression, evaluated in a named zone by a child `node`. */
  const parseInZone = (tz: string, text: string): number => Number(execFileSync(
    process.execPath,
    ['-e', 'const t=process.argv[1];const w=t.endsWith("Z")||t.includes("+")?t:t+"Z";process.stdout.write(String(Date.parse(w)))', text],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' },
  ));
  /** …and the naive form, for the contrast that makes the clause mean something. */
  const naiveInZone = (tz: string, text: string): number => Number(execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(Date.parse(process.argv[1])))', text],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' },
  ));

  const TRUE_MS = Date.parse('2026-09-27T05:28:30Z');

  it('every zone — including half- and quarter-hour offsets — returns the SAME UTC instant', () => {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Australia/Eucla', 'Pacific/Chatham']) {
      expect(parseInZone(tz, BOUNDARY_TEXT), tz).toBe(TRUE_MS);
    }
  });

  it('THE TRAP IS REAL, and this is what a dropped `Z` would have cost', () => {
    // Dropping the `Z` is a one-character edit and it is INVISIBLE on a UTC runner — the known false
    // green. In a UTC-7 zone the boundary lands SEVEN HOURS IN THE FUTURE, so every ask of the last
    // seven hours reads as pre-session and every recalled pair wears the tag.
    expect(naiveInZone('UTC', BOUNDARY_TEXT), 'vacuous in UTC: the two forms agree').toBe(TRUE_MS);
    const naiveLA = naiveInZone('America/Los_Angeles', BOUNDARY_TEXT);
    expect(naiveLA).not.toBe(TRUE_MS);
    expect(naiveLA - TRUE_MS).toBe(7 * 3_600_000);
    // and the consequence, stated as arithmetic on the blast's own ask
    expect(STAGE1_ASK_MS < naiveLA, 'the misparse tags an in-session ask').toBe(true);
    expect(STAGE1_ASK_MS < TRUE_MS, 'the correct parse does not').toBe(false);
  });

  it('the WRITERS strip the `Z` the reader re-appends — one seam, both ends pinned', () => {
    // If a door ever writes an ISO stamp WITH the `Z`, or with millis, the reader must still be
    // right; and if a door writes something the reader cannot parse, `null` is the answer rather
    // than a wrong number.
    expect(doorBoundary(TRUE_MS)).toBe(BOUNDARY_TEXT);
    for (const [text, want] of [
      ['2026-09-27 05:28:30', TRUE_MS],
      ['2026-09-27T05:28:30Z', TRUE_MS],
      ['2026-09-27T05:28:30.000Z', TRUE_MS],
      ['2026-09-27 05:28:30+00:00', TRUE_MS],
    ] as Array<[string, number]>) {
      setBoundary(text);
      expect(sessionBoundaryMs(AGENT), text).toBe(want);
    }
    setBoundary('not a date at all');
    expect(sessionBoundaryMs(AGENT), 'unparseable ⇒ null, never a wrong instant').toBeNull();
    setBoundary(null);
    expect(sessionBoundaryMs(AGENT)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE LEGITIMATE CASE STILL FIRES. The identity fix must not be disarmed by this guard.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 a genuinely inherited pair is still tagged', () => {
  it('a pair from before the boundary keeps its quote and wears the tag', () => {
    const old = seedPair('old', OLD_ASK_MS, 'What did we decide about the part codes?', 'BEETLE-9001.');
    setBoundary(BOUNDARY_TEXT);
    const text = laneText([old]);
    expect(text).toContain('BEETLE-9001.');
    expect(text).toContain(PRE_RESET_PAIR_TAG);
    expect(text).toContain('if asked again, answer again');
  });

  it('NO boundary at all ⇒ nothing is tagged (a fresh agent reads as it always did)', () => {
    const old = seedPair('old', OLD_ASK_MS, 'What did we decide?', 'BEETLE-9001.');
    setBoundary(null);
    expect(laneText([old])).not.toContain(PRE_RESET_PAIR_TAG);
  });

  it('a pair ON the boundary instant is IN the session, not before it', () => {
    const on = seedPair('on', Date.parse('2026-09-27T05:28:30Z'), 'Right on the second?', 'Yes.');
    setBoundary(BOUNDARY_TEXT);
    expect(laneText([on]), '>= is the session; `<` is before it').not.toContain(PRE_RESET_PAIR_TAG);
  });
});
