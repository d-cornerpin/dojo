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
//   §1 the three round-4 shapes: the lane carries the contradiction the reply needed
//   §2 the per-status table: every state's rendered truth, D4's consent gate in each line
//   §3 empty is ABSENT — no rows, no bytes, no slot
//   §4 the bound: 7 days, 5 rows, and the elision is never silent
//   §5 the tail's own laws: byte-identical 90 minutes later, and the cache-prefix position
//   §6 the wiring: one injection site, declared, protected, with its own failure path
//
// MUTATION RECORD. Each planted in the product file named, measured, then reverted by restoring the
// byte-identical file (sha256 `f2661cbc` for `report/state-lane.ts` and `0fe765d1` for
// `steps/call-llm/pre-call-injections.ts`, re-asserted after every one):
//
//   M1  the injection site DELETED — the lane never reaches the model   4 F / 22 P  §3 §5 §6
//   M2  `cancelled` rendered as a standing card                          3 F / 23 P  §1 §2
//   M3  the row bound removed (no LIMIT)                                 1 F / 25 P  §4
//   M4  the superseding sentence dropped from the block                  1 F / 25 P  §1
//   M5  the recorded instant swapped for a wall-clock reading            1 F / 25 P  §5
//   M6  the 7-day window removed (every report ever, for ever)           1 F / 25 P  §3
//   M7  EMPTY IS ABSENT broken (an empty header instead of null)          3 F / 23 P  §1 §3
//
// M1 is the one that matters most and it is caught STRUCTURALLY rather than behaviourally: a unit
// test cannot see the model's context, so §3/§5/§6 read the injection site out of the engine corpus
// (`engine-sources.ts`, never by path — the guard-corpus census refuses a second hand-rolled walk).
// M2's first cut reded only 2 clauses because the legend still said the word; §1's shape-0 clause now
// asserts the ROW form, so a mis-rendered row cannot pass wearing the legend's clothes.
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
  REPORT_STATE_HEAD, REPORT_STATE_MAX_ROWS, REPORT_STATE_TAIL, REPORT_STATE_WINDOW_DAYS,
  buildReportStateInjection, recentReportRows, renderReportStateBlock,
} from '../state-lane.js';
import { POST_BUDGET_ENTRY_LANE, isProtectedLaneId } from '../../memory/lanes.js';
import { engineFileContaining, engineText } from '../../agent/v2/__tests__/engine-sources.js';
import { cancelReport, createReport, submitForApproval, attachDraft } from '../store.js';

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
// §3 — EMPTY IS ABSENT.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 an agent with no recent reports renders nothing at all', () => {
  it('no rows → null, not an empty header', () => {
    expect(buildReportStateInjection(AGENT)).toBeNull();
    expect(renderReportStateBlock([])).toBeNull();
  });

  it('rows OUTSIDE the window → still null (126 of 138 agents on the owner\'s box are this case)', () => {
    seedReport({ id: 'ancient', status: 'cancelled', updatedAt: daysAgo(REPORT_STATE_WINDOW_DAYS + 1) });
    expect(recentReportRows(AGENT).rows).toHaveLength(0);
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
    const { rows, totalInWindow } = recentReportRows(AGENT);
    expect(rows).toHaveLength(REPORT_STATE_MAX_ROWS);
    expect(totalInWindow).toBe(REPORT_STATE_MAX_ROWS + 3);
    expect(rows[0].id).toBe('row-0'); // newest updated_at
    const b = block();
    expect((b.match(/^\d+\. /gm) ?? [])).toHaveLength(REPORT_STATE_MAX_ROWS);
    // The elision states the bound rather than implying completeness the read does not have.
    expect(b).toContain(`Showing the ${REPORT_STATE_MAX_ROWS} most recently changed of ${REPORT_STATE_MAX_ROWS + 3}`);
    expect(b).not.toContain('That is every report');
  });

  it('inside the cap it claims completeness for the window, and nothing wider', () => {
    seedReport({ id: 'one', status: 'cancelled', updatedAt: daysAgo(0) });
    const b = block();
    expect(b).toContain(`That is every report of yours changed in the last ${REPORT_STATE_WINDOW_DAYS} days`);
    expect(b).toContain('Anything not listed is not on their dashboard');
  });

  it('the whole block stays small enough to ride a tail — the widest real agent is 1,397 bytes', () => {
    for (let i = 0; i < REPORT_STATE_MAX_ROWS; i++) {
      seedReport({ id: `wide-${i}-0000-0000-0000-00000000000${i}`, status: 'cancelled', updatedAt: daysAgo(i * 0.01) });
    }
    const bytes = Buffer.byteLength(block(), 'utf8');
    expect(bytes).toBeGreaterThan(400);
    expect(bytes, 'a per-turn tail block that grows unbounded re-bills the whole history behind it')
      .toBeLessThan(2_000);
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
        if (fs.readFileSync(abs, 'utf8').includes("report/state-lane.js")) {
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
