// ════════════════════════════════════════════════════════════════════════════════════════
// THE ENGINE SAYS WHAT HAPPENED TO THE CARD — the v3.2.0 release ritual's ROUND-4 red.
//
// FOUR ROUNDS, AND THE FIRST THREE SUPPRESSED A CARRIER. Rounds 2-3 shut down the engine's
// re-answer record about a withdrawn report (the `RECENTLY ANSWERED` list, the recall lane's
// verbatim `ALREADY ANSWERED` pair, the no-reply ladder's quote). Round 4 proved the claim does not
// need any of them: on THREE fresh agents, through the real doors, after a real cancel, with every
// one of those blocks *provably absent from the literal messages array*, the model still answered
//
//     "It's sitting on your dashboard as a preview card under ID 0f6f237c-6b28-4089-acff-…"
//
// — reading its OWN earlier reply out of the ordinary fresh tail. That reply was TRUE WHEN WRITTEN.
// Nothing in the engine ever told the turn what became of the card: `listOpenReports` had exactly
// one consumer, the dashboard's HTTP route, and no context lane, prompt assembly or memory lane read
// live report state at all. There is nothing false to suppress — the agent is reasoning correctly
// from everything it was shown — so the fix is not suppression. It is a FRESHER RECORD, in the shape
// this tree already uses for exactly this class of defect: `engine.open-commitments`, a snapshot of
// current state that says in words that it supersedes earlier mentions.
//
// WHAT EACH SECTION HOLDS
//   §1  the three round-4 shapes: the lane carries the contradiction the reply needed
//   §2  the per-status table: every state's rendered truth, D4's consent gate in each line
//   §2b a LIVE card is never elided, never ages out, and is never called history (review F1)
//   §3  empty is ABSENT — no rows, no bytes, no slot
//   §4  the bounds: the settled cap, the live cap, and both worst cases measured (review F3)
//   §5  the tail's laws + the prefix proof, closed under resolver-legal spellings (review F2)
//   §6  the wiring: one injection site, declared, protected, with its own failure path
//
// ── THE REVIEW'S THREE FINDINGS, AND WHY §2b EXISTS AT ALL ───────────────────────────────────
// F1 (MEDIUM) was the mirror image of the defect this lane closes. The block makes a NEGATIVE
// completeness claim, so only a non-terminal row can falsify it — and the first cut let one be
// elided by the 5-row cap or aged out by the 7-day horizon. The superseding sentence then told the
// model that a TRUE "your card is waiting" line was history: the agent says nothing is pending, the
// user never presses Post, and a real report dies at the consent gate. Non-terminal rows now never
// age out and are never elided, and when the live safety cap IS hit the block WITHHOLDS its negative
// claim instead of lying about what it left out.
//
// ── MUTATION RECORD. Each planted in the product file named, measured, then reverted by restoring
// the byte-identical file (sha256 `a0c0283d` for `report/state-lane.ts`, `0fe765d1` for
// `steps/call-llm/pre-call-injections.ts`, `8ab9a96d` for `prompt/registry/entries.ts`, re-asserted
// after every one). 35 clauses:
//
//   M1  the injection site DELETED — the lane never reaches the model   4 F / 31 P  §3 §5 §6
//   M2  `cancelled` rendered as a standing card                          3 F / 32 P  §1 §2
//   M3  the SETTLED row bound removed (no LIMIT)                         1 F / 34 P  §4
//   M4  the superseding sentence dropped from the block                  3 F / 32 P  §1 §4 §5
//   M5  the recorded instant swapped for a wall-clock reading            1 F / 34 P  §5
//   M6  the 7-day window removed for settled rows                        2 F / 33 P  §2b §3
//   M7  EMPTY IS ABSENT broken (an empty header instead of null)          4 F / 31 P  §1 §2b §3
//   M8  F2: the reviewer's EXACT plant — a second, EXTENSIONLESS
//       importer of this lane in a prefix file                           1 F / 34 P  §5
//   M9  F1: the UNIFORM horizon restored (live rows age out)             3 F / 32 P  §2b
//   M10 F1: the row cap applied to live rows (a card can be elided)      2 F / 33 P  §2b §4
//   M11 F1: the negative completeness claim made UNCONDITIONAL           1 F / 34 P  §4
//
// M1 is the one that matters most and it is caught STRUCTURALLY rather than behaviourally: a unit
// test cannot see the model's context, so §3/§5/§6 read the injection site out of the engine corpus
// (`engine-sources.ts`, never by path — the guard-corpus census refuses a second hand-rolled walk).
// M8 is the review's own successful attack on the PROOF rather than the code: against the first cut
// it was GREEN (the clause grepped a literal string under `moduleResolution: "bundler"`), and the
// reader is closed under resolver-legal spellings now, with a fixture table of caught/ignored rows.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-report-state-lane-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  REPORT_STATE_HEAD, REPORT_STATE_LIVE_CAP, REPORT_STATE_MAX_ROWS, REPORT_STATE_TAIL,
  REPORT_STATE_WINDOW_DAYS,
  buildReportStateInjection, recentReportRows, renderReportStateBlock,
} from '../state-lane.js';
import { POST_BUDGET_ENTRY_LANE, isProtectedLaneId } from '../../memory/lanes.js';
import { engineFileContaining, engineText } from '../../agent/v2/__tests__/engine-sources.js';
import { cancelReport, createReport, submitForApproval, attachDraft } from '../store.js';
import { draftHead, gatherHead, submitHead } from '../../agent/tools/cat/report-prose.js';

/** The lane's own source, for the structural clauses. */
const laneSource = (): string => fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state-lane.ts'), 'utf8',
);

const AGENT = 'card-owner';
const OTHER = 'card-owner-two';
const db = (): Database.Database => mockDb.current!;

/** A report row in an exact state at an exact recorded instant. */
function seedReport(p: { id: string; status: string; updatedAt: string; agentId?: string; issueUrl?: string }): string {
  db().prepare(
    `INSERT INTO dojo_reports (id, agent_id, status, lane, signature, created_at, updated_at, issue_url)
     VALUES (?, ?, ?, 'other', ?, ?, ?, ?)`,
  ).run(p.id, p.agentId ?? AGENT, p.status, `sig-${p.id}`, p.updatedAt, p.updatedAt, p.issueUrl ?? null);
  return p.id;
}
const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');

const block = (agentId = AGENT): string => buildReportStateInjection(agentId) ?? '';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [AGENT, OTHER]) {
    db().prepare(
      `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, ?, 'idle', '1970-01-01')`,
    ).run(id, id);
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE THREE ROUND-4 SHAPES. Each is the state the gate turn's context actually held, and
// each clause asserts the one sentence the reply needed and did not have.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the three round-4 shapes get the contradiction their reply needed', () => {
  const ID = '0f6f237c-6b28-4089-acff-8187eb00cef7'; // shape 0's real row id

  it('shape 0 — file, cancel, re-ask: the lane names the id and says NOTHING is on the dashboard', () => {
    seedReport({ id: ID, status: 'cancelled', updatedAt: daysAgo(0) });
    const b = block();
    // The id the model named in its false claim, and the fact that contradicts it.
    // The ROW form, not just the legend's word: a row that renders the wrong state word is the
    // whole defect wearing the fix's clothes.
    expect(b).toContain(`${ID} — WITHDRAWN `);
    expect(b).not.toContain('— PREVIEW CARD UP');
    expect(b).toContain('the user can see NOTHING');
    expect(b).toContain('nothing reached the Dojo builders');
    // The instruction that makes the next turn serve the owner rather than point at a dead card.
    expect(b).toMatch(/file a FRESH report/i);
    // And it explicitly overrides the agent's own earlier words, which is where the claim lives.
    expect(b).toContain('including your own');
    for (const phrase of ['sitting on your dashboard', 'preview card', 'waiting for you to press Post']) {
      expect(b, 'the negative instruction must name the failure\'s own vocabulary').toContain(phrase);
    }
    expect(b).toContain('history and no longer applies');
  });

  it('shape 1 — the card STILL standing renders the opposite, and never implies it was sent', () => {
    // Round 4's shape 1 before the cancel: this is the clause that stops the fix from becoming a
    // blanket "there is no card" lie, and it holds the no-false-delivery line (D4).
    const live = seedReport({ id: 'fc25b9fe-7b15-40ae-a7c4-8628d59ab50f', status: 'awaiting_approval', updatedAt: daysAgo(0) });
    const b = block();
    expect(b).toContain(live);
    expect(b).toContain('PREVIEW CARD UP');
    expect(b).toContain('the decision is theirs');
    expect(b).toContain('Nothing has been sent yet');
    expect(b).toContain('cannot press Post for them');
    expect(b, 'a standing card must not be described as withdrawn').not.toContain('— WITHDRAWN');
  });

  it('shape 2 — the deeper re-ask: the lane is the same record however many times they ask', () => {
    // Shape 2 reached the residual `TURNS_BACK` leaves open in the withdrawal predicate. This lane
    // has no generation at all: it is read from the row every turn, so the third re-ask and the
    // first get the identical record.
    seedReport({ id: '6d6ecfeb-8faf-4524-9d84-7f73aff09e90', status: 'cancelled', updatedAt: daysAgo(0) });
    const first = block();
    const third = block();
    expect(third).toBe(first);
    expect(third).toContain('WITHDRAWN');
  });

  it('END TO END THROUGH THE REAL DOORS: submit then cancel, and the lane follows the row', () => {
    const row = createReport(AGENT, 'wrong-answer', 'sig-live');
    attachDraft(row.id, {
      lane: 'wrong-answer',
      signature: 'sig-live',
      brief: { title: 't', whatHappened: 'w', whatShouldHaveHappened: 's', whyItWentWrong: 'y', fixIdeas: 'f' },
      telemetry: {},
      bundlePath: '/tmp/b.json',
    });
    expect(submitForApproval(row.id)?.status).toBe('awaiting_approval');
    expect(block()).toContain('PREVIEW CARD UP');
    expect(cancelReport(row.id)?.status).toBe('cancelled');
    const after = block();
    expect(after).toContain('— WITHDRAWN');
    expect(after).not.toContain('— PREVIEW CARD UP');
  });

  it('another agent\'s report is never in this agent\'s lane', () => {
    seedReport({ id: 'theirs-0000-0000-0000-000000000001', status: 'awaiting_approval', updatedAt: daysAgo(0), agentId: OTHER });
    expect(buildReportStateInjection(AGENT)).toBeNull();
    expect(buildReportStateInjection(OTHER)).toContain('PREVIEW CARD UP');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE PER-STATUS TABLE. One row per state, and the truth each one must carry.
// ════════════════════════════════════════════════════════════════════════════════════════

const TABLE: Array<{ status: string; word: string; must: string[]; mustNot: string[] }> = [
  { status: 'cancelled', word: 'WITHDRAWN',
    must: ['the user can see NOTHING', 'file a FRESH report', 'cannot be revived'],
    mustNot: ['— PREVIEW CARD UP', '— FILED'] },
  { status: 'awaiting_approval', word: 'PREVIEW CARD UP',
    must: ['decision is theirs', 'Nothing has been sent yet'], mustNot: ['— WITHDRAWN'] },
  { status: 'drafting', word: 'UNFINISHED',
    must: ['the user can see NOTHING yet', 'phase="submit"', 'CAN still be finished'],
    mustNot: ['— PREVIEW CARD UP', '— WITHDRAWN'] },
  { status: 'approved', word: 'APPROVED, SENDING',
    must: ['do not promise a link'], mustNot: ['— WITHDRAWN'] },
  { status: 'posted', word: 'FILED',
    must: ['reached the builders'], mustNot: ['— WITHDRAWN', '— PREVIEW CARD UP'] },
  { status: 'exported-by-a-future-writer', word: 'UNRECOGNISED STATE',
    must: ['NOT on their dashboard'], mustNot: ['— FILED', '— PREVIEW CARD UP'] },
];

describe('§2 every state renders the truth that decides what the user can see', () => {
  for (const row of TABLE) {
    it(`${row.status} → ${row.word}`, () => {
      seedReport({
        id: `r-${row.status}-0000-0000-000000000001`, status: row.status, updatedAt: daysAgo(0),
        issueUrl: row.status === 'posted' ? 'https://example.invalid/issues/7' : undefined,
      });
      const b = block();
      expect(b).toContain(row.word);
      for (const m of row.must) expect(b.toLowerCase()).toContain(m.toLowerCase());
      // The mustNot forms carry the row's em dash: the superseding paragraph NAMES the phrases on
      // purpose ("not listed below as PREVIEW CARD UP"), so only the ROW may be checked for absence.
      for (const n of row.mustNot) expect(b).not.toContain(n);
    });
  }

  it('a posted row carries its issue URL, and a posted row without one says so instead of inventing it', () => {
    seedReport({ id: 'p-1', status: 'posted', updatedAt: daysAgo(0), issueUrl: 'https://example.invalid/issues/9' });
    expect(block()).toContain('https://example.invalid/issues/9');
    db().prepare('DELETE FROM dojo_reports').run();
    seedReport({ id: 'p-2', status: 'posted', updatedAt: daysAgo(0) });
    expect(block()).toContain('no link recorded');
  });

  it('the legend covers only the states PRESENT — bytes the turn does not need are not spent', () => {
    seedReport({ id: 'only-cancelled', status: 'cancelled', updatedAt: daysAgo(0) });
    const b = block();
    expect(b).toContain('WITHDRAWN means the user can see NOTHING');
    expect(b, 'no card is up, so its legend line has no business being here').not.toContain('PREVIEW CARD UP means');
    expect(b).not.toContain('FILED means');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2b — F1 (review, MEDIUM): A STANDING CARD IS NEVER ELIDED AND NEVER AGES OUT.
//
// The block makes a NEGATIVE completeness claim, so only a non-terminal row can falsify it — and
// falsifying it kills a real report at the consent gate: the superseding sentence would tell the
// model that a TRUE "your card is waiting" line "is history and no longer applies", the agent says
// nothing is pending, the user never presses Post. The two reachable shapes the reviewer measured
// are the first two clauses here.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2b a live card cannot be elided, aged out, or called history', () => {
  it('SHAPE A — five cancels today + one standing card: the cap must not squeeze the card out', () => {
    for (let i = 0; i < REPORT_STATE_MAX_ROWS; i++) {
      seedReport({ id: `fresh-cancel-${i}`, status: 'cancelled', updatedAt: daysAgo(0.001 * i) });
    }
    const card = seedReport({ id: 'the-live-card', status: 'awaiting_approval', updatedAt: daysAgo(3) });
    const b = block();
    expect(b, 'the card the user is looking at RIGHT NOW was elided by the row cap').toContain(card);
    expect(b).toContain(`${card} — PREVIEW CARD UP`);
    // …and it is FIRST: a live card outranks five settled ones for the turn that has to answer.
    expect(b.indexOf(card)).toBeLessThan(b.indexOf('fresh-cancel-0'));
    // The completeness claim is now TRUE, so it is still made.
    expect(b).toContain('Every report of yours that is still LIVE is listed above');
  });

  it('SHAPE B — a NINE-DAY-OLD standing card still renders (non-terminal rows never age out)', () => {
    const old = seedReport({ id: 'nine-days-old-card', status: 'awaiting_approval', updatedAt: daysAgo(9) });
    seedReport({ id: 'fresh-cancel', status: 'cancelled', updatedAt: daysAgo(0) });
    const read = recentReportRows(AGENT);
    expect(read.live.map((r) => r.id)).toEqual([old]);
    const b = block();
    expect(b, 'an aged-out standing card is the F1 defect: the block would call a true claim history')
      .toContain(`${old} — PREVIEW CARD UP`);
    expect(b).toContain('however old it is');
  });

  it('the other two non-terminal states age out no more than the card does', () => {
    seedReport({ id: 'old-draft', status: 'drafting', updatedAt: daysAgo(30) });
    seedReport({ id: 'old-approved', status: 'approved', updatedAt: daysAgo(400) });
    const read = recentReportRows(AGENT);
    expect(read.live.map((r) => r.id).sort()).toEqual(['old-approved', 'old-draft']);
    expect(block()).toContain('UNFINISHED');
    expect(block()).toContain('APPROVED, SENDING');
  });

  it('CONTROL — a TERMINAL row DOES age out, which is what keeps the block small', () => {
    // The horizon is safe for terminal rows for one measured reason: `cancelReport` stamps
    // `updated_at = datetime('now')`, so a withdrawn row is always fresh at the instant of
    // withdrawal. An 8-day-old cancelled row is a cancel nobody has asked about since.
    seedReport({ id: 'old-cancel', status: 'cancelled', updatedAt: daysAgo(8) });
    seedReport({ id: 'old-posted', status: 'posted', updatedAt: daysAgo(8) });
    expect(recentReportRows(AGENT).settled).toHaveLength(0);
    expect(buildReportStateInjection(AGENT)).toBeNull();
  });

  it('the cancel door itself keeps the horizon honest: cancelling REFRESHES updated_at', () => {
    const row = createReport(AGENT, 'wrong-answer', 'sig-h');
    db().prepare("UPDATE dojo_reports SET created_at = ?, updated_at = ? WHERE id = ?")
      .run(daysAgo(20), daysAgo(20), row.id);
    expect(recentReportRows(AGENT).live.map((r) => r.id)).toEqual([row.id]); // drafting: never ages
    expect(cancelReport(row.id)?.status).toBe('cancelled');
    const read = recentReportRows(AGENT);
    expect(read.live).toHaveLength(0);
    expect(read.settled.map((r) => r.id), 'the 7-day clock runs from the CANCEL, not the filing')
      .toEqual([row.id]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — EMPTY IS ABSENT.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 an agent with no recent reports renders nothing at all', () => {
  it('no rows → null, not an empty header', () => {
    expect(buildReportStateInjection(AGENT)).toBeNull();
    expect(renderReportStateBlock([])).toBeNull();
  });

  it('a SETTLED row outside the window → still null (126 of 138 agents on the owner\'s box are this case)', () => {
    seedReport({ id: 'ancient', status: 'cancelled', updatedAt: daysAgo(REPORT_STATE_WINDOW_DAYS + 1) });
    const read = recentReportRows(AGENT);
    expect(read.settled).toHaveLength(0);
    expect(read.live).toHaveLength(0);
    expect(buildReportStateInjection(AGENT)).toBeNull();
  });

  it('and the injection site pushes nothing when the builder returns null', () => {
    // The site's shape is what makes "empty is absent" true in the array rather than only here.
    const site = engineFileContaining("'engine.report-state'");
    expect(site, 'no engine source injects the report-state lane — the site MOVED').not.toBeNull();
    expect(site!.text).toMatch(/if \(reportStateBlock\) pushEngineMessage\(/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE BOUND, AND THE ELISION THAT IS NEVER SILENT.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 the read is bounded and says so', () => {
  it(`at most ${REPORT_STATE_MAX_ROWS} rows, newest change first`, () => {
    for (let i = 0; i < REPORT_STATE_MAX_ROWS + 3; i++) {
      seedReport({ id: `row-${i}`, status: 'cancelled', updatedAt: daysAgo(i * 0.01) });
    }
    const read = recentReportRows(AGENT);
    expect(read.settled).toHaveLength(REPORT_STATE_MAX_ROWS);
    expect(read.settledInWindow).toBe(REPORT_STATE_MAX_ROWS + 3);
    expect(read.settled[0].id).toBe('row-0'); // newest updated_at
    const b = block();
    expect((b.match(/^\d+\. /gm) ?? [])).toHaveLength(REPORT_STATE_MAX_ROWS);
    // The elision states the bound rather than implying completeness the read does not have.
    expect(b).toContain(`these are the ${REPORT_STATE_MAX_ROWS} most recently changed of ${REPORT_STATE_MAX_ROWS + 3}`);
    expect(b).toContain('Older WITHDRAWN/FILED reports are not listed');
  });

  it('inside the cap it claims completeness for the LIVE set, and nothing wider', () => {
    seedReport({ id: 'one', status: 'cancelled', updatedAt: daysAgo(0) });
    const b = block();
    expect(b).toContain('Every report of yours that is still LIVE is listed above, however old it is');
    expect(b).toContain('anything not listed is settled, and not a card on their dashboard');
    expect(b).not.toContain('Older WITHDRAWN/FILED reports are not listed');
  });

  it('F3 the WIDEST REALISTIC shape is measured, not the cheapest one: five distinct states', () => {
    // The review's F3: the first cut measured five IDENTICAL rows (one legend line, 1,452 B) and
    // guarded at 2,000 — a bound its own widest case breaches. Five DISTINCT states render every
    // legend line, which is the real worst case a live agent can reach, and it measures 2,262 B.
    const states = ['awaiting_approval', 'drafting', 'approved', 'cancelled', 'posted'];
    states.forEach((status, i) => seedReport({
      id: `0000000${i}-1111-4000-8000-000000000000`, status, updatedAt: daysAgo(i * 0.01),
      issueUrl: status === 'posted' ? 'https://github.com/d-cornerpin/dojo-report-live-test/issues/123' : undefined,
    }));
    const b = block();
    // Every legend line is present — this is what makes it the widest shape.
    for (const word of ['WITHDRAWN means', 'UNFINISHED means', 'PREVIEW CARD UP means',
      'APPROVED, SENDING means', 'FILED means']) expect(b).toContain(word);
    const bytes = Buffer.byteLength(b, 'utf8');
    expect(bytes).toBeGreaterThan(2_000);           // it really is the wide one
    expect(bytes, 'measured 2,262 B — the guard is set from the measurement, with headroom for '
      + 'one more state word, and NOT from the cheapest fixture').toBeLessThan(2_400);
  });

  it('F1 the PATHOLOGICAL bound: the live cap is the ceiling, and hitting it withholds the claim', () => {
    // Non-terminal rows never age out and are never elided, so the live safety cap is the only
    // thing bounding this block. Measured at the cap: 4,033 B, and the negative completeness claim
    // is WITHHELD rather than asserted over a list that is admittedly short.
    for (let i = 0; i <= REPORT_STATE_LIVE_CAP; i++) {
      seedReport({ id: `live-${String(i).padStart(2, '0')}`, status: 'awaiting_approval', updatedAt: daysAgo(i * 0.01) });
    }
    const read = recentReportRows(AGENT);
    expect(read.live).toHaveLength(REPORT_STATE_LIVE_CAP);
    expect(read.liveTruncated).toBe(true);
    const b = block();
    expect(b).toContain('⚠ INCOMPLETE');
    expect(b).toContain('Do NOT tell the user that nothing of theirs is pending');
    expect(b, 'the false negative claim is the F1 defect — it must be absent here')
      .not.toContain('anything not listed is settled');
    expect(Buffer.byteLength(b, 'utf8'), 'measured 4,033 B at the cap with five settled rows')
      .toBeLessThan(4_600);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE TAIL'S OWN LAWS. This block lives in the volatile tail, so it obeys the two rules
// every other block there obeys: it does not tick, and it does not move the cached prefix.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 it does not tick, and it does not touch the prefix', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('byte-identical 90 minutes later — the clock is not a source', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
    seedReport({ id: 'still-1', status: 'cancelled', updatedAt: '2026-09-26 11:20:00' });
    seedReport({ id: 'still-2', status: 'awaiting_approval', updatedAt: '2026-09-26 11:40:00' });
    const before = block();
    expect(before).toContain('WITHDRAWN');
    vi.setSystemTime(new Date('2026-09-26T13:30:00Z'));
    expect(block(), 'a relative time term would have re-billed this block at every bucket boundary')
      .toBe(before);
  });

  it('F5 THE SUPERSEDING SENTENCE, on its own: the whole point of the lane, in one clause', () => {
    // The review's F5: this sentence had exactly one guard and it was shape 0's nine-assertion
    // clause, so any future narrowing of that clause would have removed the sentence's only cover.
    // It is the mechanism — everything else here is plumbing around it.
    seedReport({ id: 'sup-1', status: 'cancelled', updatedAt: daysAgo(0) });
    const b = block();
    // (i) it supersedes, and it says WHAT it supersedes — including the agent's own replies, which
    //     is where round 4 proved the claim actually lives.
    expect(b).toContain('This supersedes every earlier mention of a report in this conversation');
    expect(b).toContain('including your own replies');
    expect(b).toContain('those were true when written and this is true NOW');
    // (ii) it states the consent gate, so "filed" cannot be read as "sent".
    expect(b).toContain('A report reaches the Dojo ONLY when the user presses Post');
    // (iii) it names the failure's OWN vocabulary — the three phrases the four red rounds produced.
    for (const phrase of ['sitting on your dashboard', 'preview card', 'waiting for you to press Post']) {
      expect(b).toContain(phrase);
    }
    // (iv) and it gives the instruction, conditioned on the row rather than on the words.
    expect(b).toContain('not listed below as PREVIEW CARD UP');
    expect(b).toContain('history and no longer applies');
    expect(b).toContain('do not repeat it as the current state');
  });

  it('CONTROL — when a row actually changes, the bytes change', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
    seedReport({ id: 'ctrl', status: 'awaiting_approval', updatedAt: '2026-09-26 11:20:00' });
    const before = block();
    db().prepare("UPDATE dojo_reports SET status = 'cancelled', updated_at = '2026-09-26 11:50:00'").run();
    expect(block()).not.toBe(before);
  });

  it('the lane is injected PAST the volatile boundary, beside the snapshot it is modelled on', () => {
    // The cache-prefix law, asserted structurally: `msg.turn-context` is the volatile boundary the
    // tail's ordering rule names, and this lane must sit behind it, next to open-commitments.
    const src = engineText();
    const at = (needle: string) => src.indexOf(needle);
    expect(at("'msg.turn-context'")).toBeGreaterThan(-1);
    expect(at("'engine.report-state'")).toBeGreaterThan(at("'msg.turn-context'"));
    expect(at("'engine.report-state'")).toBeGreaterThan(at("'engine.open-commitments'"));
    expect(at("'engine.report-state'")).toBeLessThan(at("'msg.current-time'"));
  });

  // ── F2 (review, MEDIUM): THE READER IS CLOSED UNDER RESOLVER-LEGAL SPELLINGS ──────────────
  // The first cut grepped the literal string `report/state-lane.js`. This tree is
  // `moduleResolution: "bundler"`, so the reviewer planted a SECOND importer in a prefix file
  // WITHOUT the extension, leaked the lane's header into the cached prefix, and it typechecked
  // clean while this clause stayed green and every prefix suite stayed green. The code was right;
  // the guard was not closed under new syntax. It matches the MODULE now, not a string.

  /** Every module specifier a file imports, whatever syntax carried it. */
  function importSpecifiers(src: string): string[] {
    const out: string[] = [];
    for (const re of [
      /\bfrom\s*['"]([^'"]+)['"]/g,                 // import … from '…' / export … from '…'
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,     // await import('…')
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,    // require('…')
      /\bimport\s+['"]([^'"]+)['"]/g,               // side-effect import '…'
    ]) for (const m of src.matchAll(re)) out.push(m[1]);
    return out;
  }
  /** Does this specifier resolve to THIS module, under any extension the resolver accepts? */
  const resolvesToLane = (spec: string): boolean =>
    spec.replace(/\.(?:[cm]?[jt]sx?)$/, '').split('/').pop() === 'state-lane';

  it('F2 the importer reader is CLOSED: a fixture table of caught and ignored specifiers', () => {
    const CAUGHT = [
      "import { x } from '../../../../report/state-lane.js';",   // the real one
      "import { x } from '../../../../report/state-lane';",      // the reviewer's plant
      "import { x } from '../report/state-lane.ts';",
      "import { x } from './state-lane';",
      "import { x } from './state-lane.mjs';",
      "const { x } = await import('../../report/state-lane.js');",
      "export { x } from '../report/state-lane';",
      "import '../report/state-lane.js';",
    ];
    const IGNORED = [
      "import { x } from '../report/state-lane-extra.js';",      // a different module
      "import { x } from '../report/state-laneX';",
      "import { x } from '../memory/recall-lane.js';",
      "// a comment naming report/state-lane.js is not an import",
      "const s = 'report/state-lane.js';                        // a string is not an import",
    ];
    for (const line of CAUGHT) {
      expect(importSpecifiers(line).some(resolvesToLane), line).toBe(true);
    }
    for (const line of IGNORED) {
      expect(importSpecifiers(line).some(resolvesToLane), line).toBe(false);
    }
    // The basename rule is exact only while ONE module in the tree carries that name.
    const named: string[] = [];
    const walkNames = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walkNames(abs); continue; }
        if (/^state-lane\.[cm]?[jt]sx?$/.test(e.name)) named.push(abs);
      }
    };
    walkNames(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
    expect(named).toHaveLength(1);
  });

  it('THE PREFIX CANNOT MOVE: one importer, and it is the POST-assembly tail step', () => {
    // The decisive structural proof, and it is three facts rather than a promise.
    // (1) `volatileFrom` is the LENGTH of the array the assembler returns — its own words:
    //     "everything emitted here is the cacheable region (`volatileFrom` is this array's
    //     length) … the loop appends it past the boundary". So ANY push made by the loop's
    //     injection step is behind the cache breakpoint BY CONSTRUCTION, not by placement.
    const assembler = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'memory', 'assembler.ts'), 'utf8',
    );
    expect(assembler).toContain("`volatileFrom` is this array's length");
    // (2) This lane is imported by EXACTLY ONE production file, and that file is the tail step.
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(abs); continue; }
        if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue;
        if (importSpecifiers(fs.readFileSync(abs, 'utf8')).some(resolvesToLane)) {
          importers.push(path.relative(src, abs));
        }
      }
    };
    walk(src);
    expect(importers).toEqual(['agent/v2/steps/call-llm/pre-call-injections.ts']);
    // (3) …so nothing in the PREFIX path (the assembler, the prompt registry, the tools) can
    //     even see it. A prefix entry would have to import it, and none does.
    expect(assembler).not.toContain('state-lane');
  });

  it('it adds no tool and no prefix entry — the cache-prefix golden cannot move', () => {
    // The golden is `agent/tools/definitions.ts` (blob 0d6bd0a5) plus the always-loaded tools line.
    // This lane is a tail push: it names no tool, registers no prefix entry, and the clause that
    // would catch a regression is the one above (position) plus this one (nothing in the prefix).
    const site = engineFileContaining("'engine.report-state'")!;
    expect(site.text).not.toContain('alwaysLoaded');
    expect(site.text).toContain('registry-exempt(2026-09-26)');
    for (const forbidden of ['DEFAULT_ALWAYS_LOADED_TOOLS', 'definitions.js', 'systemPrompt']) {
      expect(laneSource()).not.toContain(forbidden);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5b — ONE VOCABULARY ACROSS THE TOOL AND THE LANE (ritual round-5 red).
//
// The blast reded on an HONEST reply. The tool's submit result opened with *"Filed as `<id>`"* for a
// row that had reached nobody, the model paraphrased it — *"Report is filed as a preview card on your
// dashboard … Nothing has been sent to the Dojo builders yet. Press Post…"* — and the release gate
// read the first three words as a delivery claim. Meanwhile THIS lane's legend, which the agent reads
// on the same turn, defines the same word the other way: *"FILED means it reached the builders"*, and
// it renders PREVIEW CARD UP for exactly that row. One word, two meanings, one release.
//
// The lane's legend is the definition, so the TOOL moved. These clauses hold the vocabulary at both
// ends, because a word that means two things is not a thing one file can keep straight alone.
// ════════════════════════════════════════════════════════════════════════════════════════

/** The lane's reserved DELIVERY words: they mean the report reached the Dojo builders. */
const RESERVED_DELIVERY_WORDS = ['filed', 'posted', 'sent', 'delivered', 'published'];

describe('§5b the tool and the lane speak one vocabulary', () => {
  it('the SUBMIT result contains none of the lane\'s reserved delivery words', () => {
    const head = submitHead('acf33045-1111-4000-8000-000000000000');
    for (const word of RESERVED_DELIVERY_WORDS) {
      expect(new RegExp(`\\b${word}\\b`, 'i').test(head),
        `the submit result says "${word}" about a row that has reached nobody — that is the round-5 red`)
        .toBe(false);
    }
    // …and it says what IS true, in the lane's own words.
    expect(head).toContain('Submitted as');
    expect(head).toContain('PREVIEW CARD UP');
    expect(head).toContain('NOTHING has reached the Dojo builders');
    expect(head).toMatch(/pressing Post/);
    expect(head).toContain('you cannot press it for them');
  });

  it('the lane renders the reserved word ONLY for a row that really reached the builders', () => {
    seedReport({ id: 'vocab-posted', status: 'posted', updatedAt: daysAgo(0), issueUrl: 'https://example.invalid/i/1' });
    expect(block()).toContain('— FILED');
    db().prepare('DELETE FROM dojo_reports').run();
    // Every NOT-delivered state: the reserved word may not appear as a row's state word.
    for (const status of ['awaiting_approval', 'drafting', 'approved', 'cancelled']) {
      db().prepare('DELETE FROM dojo_reports').run();
      seedReport({ id: `vocab-${status}`, status, updatedAt: daysAgo(0) });
      const rows = block().split('\n').filter((l) => /^\d+\. /.test(l)).join('\n');
      expect(rows, `a ${status} row may not wear a delivery word`).not.toMatch(/— FILED|— POSTED|— SENT/);
    }
  });

  it('gather and draft keep their NEGATIVE uses — round 1\'s fix, true under both readings', () => {
    // The sweep's deliberate carve-out, asserted so a future "one vocabulary" pass does not delete a
    // live guard: these say the words only to DENY them, and they are pinned elsewhere by
    // `the-handoff-cannot-be-truncated-away.test.ts`.
    const g = gatherHead('abc', { askedFor: '20 turns', turns: 20, minutes: 120, truncated: false } as never).join('\n');
    expect(g).toContain('NOTHING IS FILED');
    expect(g).toContain('Do not tell them it is filed');
    expect(draftHead('abc', 'permission', 'sig').join('\n')).toContain('STILL NOT FILED');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §6 — THE WIRING: declared, protected, and with its own failure path.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§6 one injection site, declared and protected', () => {
  it('the lane id is declared in the post-budget table, so the repair may never drop it', () => {
    expect(POST_BUDGET_ENTRY_LANE['engine.report-state']).toBe('lane.loop-tail');
    expect(isProtectedLaneId('lane.loop-tail')).toBe(true);
  });

  it('the injection has its own catch and says what the turn lost', () => {
    const site = engineFileContaining("'engine.report-state'")!;
    const idx = site.text.indexOf("'engine.report-state'");
    const around = site.text.slice(idx - 600, idx + 600);
    expect(around).toContain('try {');
    expect(around).toMatch(/logger\.warn\(\s*'REPORT STATE injection FAILED/);
    expect(around, 'a lane that cannot build must not cost the turn its other lanes')
      .toContain('is NOT contradicted in front of the model');
  });

  it('the lane is read-only over report state — it is a new READER, never a writer', () => {
    for (const writer of ['UPDATE dojo_reports', 'INSERT INTO dojo_reports', 'DELETE FROM dojo_reports',
      'approveOnce', 'markPosted', 'markExported', 'releaseApproval']) {
      expect(laneSource(), 'the consent census names the doors that MOVE an approval; this lane touches none')
        .not.toContain(writer);
    }
  });
});
