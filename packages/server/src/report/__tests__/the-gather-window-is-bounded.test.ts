// ════════════════════════════════════════════════════════════════════════════════════════
// THE GATHER WINDOW IS BOUNDED (DOJO-REPORT T3).
//
// The agent names the window; the tool bounds it. That sentence has to hold in five places,
// and each block below is one of them:
//
//   1. THE CAP BINDS AND SAYS SO. Twenty turns, one hundred and twenty minutes, whatever was
//      asked for. `truncated` is the difference between a bound and a silent trim — an agent
//      that asked for a week and was given two hours must be TOLD, or it writes its brief
//      about evidence it never saw. A non-positive ask is not an ask and is not truncation.
//
//   2. THE ROW CAPS BIND. One runaway table must not crowd out every other collector's
//      evidence, so each reader carries its own LIMIT.
//
//   3. ⚠ THE WINDOW EXCLUDES, NOT ONLY INCLUDES — AND THIS IS THE HALF THE FIRST CUT MISSED.
//      Every row it seeded sat at `datetime('now')`, i.e. always inside the window, so the
//      suite could only observe that rows COME BACK. It never observed that rows STAY OUT,
//      and two mutants walked through it green: the `turns` predicate made vacuous, and the
//      `work` bound switched to epoch SECONDS against an epoch-MS column. A bound nobody
//      tests from the outside is not a bound. Every collector below is now seeded with an
//      in-window row, a row on the EXACT boundary second, and a row one second outside, in
//      that table's OWN stamp format — and `cost_records` and `work`, which had no
//      behavioural coverage of any kind, are seeded too.
//
//   4. THE SPLIT HOLDS. `audit_log.target` carries the user's file paths — measured, not
//      feared: `agent/tools/cat/fs.ts` writes fifteen such rows. It must appear in the LOCAL
//      bundle and be absent from `sources`, which is the object T1's builder reads.
//
//   5. THE STAMP FORMATS ARE LIVE, NOT ASSUMED. The plan's pinned SQL bound an ISO string
//      against columns that store SQLite's `datetime('now')` shape, which compares `'T'`
//      against `' '` and matches NOTHING. An always-empty window passes every "at most N"
//      assertion trivially, so every count clause here asserts BOTH bounds.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations.js';
import { gatherEvidence } from '../gather.js';
import {
  resolveWindow, COLLECTOR_CAPS, REPORT_WINDOW_MAX_MINUTES, REPORT_WINDOW_MAX_TURNS,
} from '../window.js';

const AGENT = 'kevin-report-window';
/** The injected clock. The standing window is 120 minutes, so it opens at 10:00:00Z. */
const NOW = new Date('2026-09-24T12:00:00.000Z');

/** The three positions every collector is seeded at, in the TEXT tables' own shape. */
const T_IN = '2026-09-24 11:00:00';
const T_EDGE = '2026-09-24 10:00:00';   // the exact boundary second — `>=`, so IN
const T_OUT = '2026-09-24 09:59:59';    // one second outside — OUT
/** …and in epoch milliseconds, which is what `work` and `messages` store. */
const MS_IN = Date.parse('2026-09-24T11:00:00Z');
const MS_EDGE = Date.parse('2026-09-24T10:00:00Z');
const MS_OUT = Date.parse('2026-09-24T09:59:59Z');

const SECRET_PATH = '/Users/dave/taxes.pdf';
const STALE_PATH = '/Users/dave/last-tuesday.pdf';

describe('resolveWindow bounds what the agent asked for', () => {
  it('gives the standing window when nothing is asked, and calls it untruncated', () => {
    const w = resolveWindow({}, NOW);
    expect(w.turns).toBe(REPORT_WINDOW_MAX_TURNS);
    expect(w.minutes).toBe(REPORT_WINDOW_MAX_MINUTES);
    expect(w.truncated).toBe(false);
  });

  it('honours an ask that is inside the cap, exactly', () => {
    const w = resolveWindow({ turns: 5, minutes: 15 }, NOW);
    expect(w.turns).toBe(5);
    expect(w.minutes).toBe(15);
    expect(w.truncated).toBe(false);
  });

  it('clamps an oversized turn count and reports the trim', () => {
    const w = resolveWindow({ turns: 500 }, NOW);
    expect(w.turns).toBe(REPORT_WINDOW_MAX_TURNS);
    expect(w.truncated).toBe(true);
    expect(w.askedFor).toContain('500');
  });

  it('clamps "since last Tuesday" to two hours and reports the trim', () => {
    const w = resolveWindow({ minutes: 10080 }, NOW);
    expect(w.minutes).toBe(REPORT_WINDOW_MAX_MINUTES);
    expect(w.truncated).toBe(true);
  });

  it('treats a negative or non-finite ask as no ask — never a window that ends before it starts', () => {
    for (const req of [{ turns: -3 }, { turns: 0 }, { minutes: Number.NaN }, { minutes: -1 }]) {
      const w = resolveWindow(req, NOW);
      expect(w.turns, JSON.stringify(req)).toBe(REPORT_WINDOW_MAX_TURNS);
      expect(w.minutes, JSON.stringify(req)).toBe(REPORT_WINDOW_MAX_MINUTES);
      // Nothing was SHORTENED — the ask was never a window. The two facts are different.
      expect(w.truncated, JSON.stringify(req)).toBe(false);
    }
  });

  it('starts the window exactly `minutes` before the injected now', () => {
    const w = resolveWindow({ minutes: 30 }, NOW);
    expect(w.sinceIso).toBe(new Date(NOW.getTime() - 30 * 60_000).toISOString());
    expect(NOW.getTime() - Date.parse(w.sinceIso)).toBe(30 * 60_000);
  });
});

// ── seeding ─────────────────────────────────────────────────────────────────────────────
// Stamps are written the way PRODUCTION writes them: `datetime('now')`-shaped TEXT for the
// four text-stamped tables, epoch MILLISECONDS for `work` and `messages`. Seeding ISO here
// would make the test agree with a reader that production disagrees with.

function base(): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO providers (id, name, type, auth_type) VALUES ('p-r', 'P', 'anthropic', 'none')").run();
  db.prepare("INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id) VALUES ('m-r', 'p-r', 'M', 'm')").run();
  db.prepare("INSERT OR IGNORE INTO agents (id, name, model_id, status) VALUES (?, 'Kevin', 'm-r', 'idle')").run(AGENT);
}

function turn(n: number, at: string): void {
  getDb().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, subject_kind, answered, effectful_calls,
                        started_at, ended_at, exit_reason)
     VALUES (?, ?, 'user', 'conv', 0, 0, ?, ?, 'brake')`,
  ).run(AGENT, n, at, at);
}

function auditRow(id: string, target: string, callId: string, at: string): void {
  getDb().prepare(
    `INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, call_id, created_at)
     VALUES (?, ?, 'file_read', ?, 'denied', 'File not found', ?, ?)`,
  ).run(id, AGENT, target, callId, at);
}

function toolUseMessage(id: string, callId: string, argPath: string, createdMs: number): void {
  getDb().prepare(
    `INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier,
                           turn_number, provenance, authorized, token_count, created_at)
     VALUES (?, ?, 'assistant', 'owner', ?, 'agent-text', 'agent-only', 1, 'live', 1, 10, ?)`,
  ).run(id, AGENT, JSON.stringify([
    { type: 'tool_use', id: callId, name: 'file_read', input: { path: argPath } },
  ]), createdMs);
}

/** Everything at once, inside the window. For the cap and privacy blocks. */
function seedAtNow(turnCount: number): void {
  base();
  for (let i = 1; i <= turnCount; i++) turn(i, T_IN);
  auditRow('al-1', SECRET_PATH, 'call_1', T_IN);
  getDb().prepare(
    `INSERT INTO agent_tool_failures (agent_id, signature, tool_name, hit_count, last_at)
     VALUES (?, 'sig-1', 'file_read', 4, ?)`,
  ).run(AGENT, T_IN);
  // THE ASSISTANT ROW THAT NAMES THE TOOL. Without it there are no tool-call facts at all,
  // and the privacy clauses pass VACUOUSLY — which is exactly how the first cut of this file
  // let the `target`-into-`sources` mutant survive.
  toolUseMessage('msg-1', 'call_1', SECRET_PATH, MS_IN);
}

/** One row IN, one ON the boundary second, one OUT — for every collector. */
function seedBoundary(): void {
  const db = getDb();
  base();
  turn(1, T_OUT); turn(2, T_EDGE); turn(3, T_IN);
  for (const [i, at] of [[1, T_OUT], [2, T_EDGE], [3, T_IN]] as const) {
    db.prepare(
      `INSERT INTO cost_records (id, agent_id, provider_id, model_id, request_type,
                                 input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?, ?, 'p-r', 'm-r', 'agent_turn', ?, 1, 0, ?)`,
    ).run(`cr-${i}`, AGENT, i, at);
  }
  auditRow('al-out', STALE_PATH, 'call_out', T_OUT);
  auditRow('al-edge', SECRET_PATH, 'call_edge', T_EDGE);
  auditRow('al-in', SECRET_PATH, 'call_in', T_IN);
  for (const [sig, at] of [['s-out', T_OUT], ['s-edge', T_EDGE], ['s-in', T_IN]] as const) {
    db.prepare(
      `INSERT INTO agent_tool_failures (agent_id, signature, tool_name, hit_count, last_at)
       VALUES (?, ?, 'file_read', 4, ?)`,
    ).run(AGENT, sig, at);
  }
  for (const [i, ms] of [['w-out', MS_OUT], ['w-edge', MS_EDGE], ['w-in', MS_IN]] as const) {
    db.prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                         wakes, closes_thread, opened_at, updated_at)
       VALUES (?, 'task', ?, 'owner', 'conv', 'c1', 'open', 'FYI', 0, 0, ?, ?)`,
    ).run(i, AGENT, MS_IN, ms);
  }
  toolUseMessage('m-out', 'call_out', STALE_PATH, MS_OUT);
  toolUseMessage('m-edge', 'call_edge', SECRET_PATH, MS_EDGE);
  toolUseMessage('m-in', 'call_in', SECRET_PATH, MS_IN);
}

beforeEach(() => {
  runMigrations();
  const db = getDb();
  for (const t of ['turns', 'audit_log', 'agent_tool_failures', 'cost_records', 'work', 'messages']) {
    db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(AGENT);
  }
});

describe('the per-collector row caps bind against a seeded body', () => {
  it('returns at most COLLECTOR_CAPS.turns turn rows when twice that many exist', () => {
    seedAtNow(COLLECTOR_CAPS.turns * 2);
    const ev = gatherEvidence(AGENT, {}, NOW);
    // An empty result would satisfy "at most" trivially — the stamp-format defect this
    // file exists to catch is exactly an always-empty window, so assert an EXACT count.
    expect(ev.sources.turns.length).toBe(COLLECTOR_CAPS.turns);
  });

  it('carries the window it actually used into the telemetry sources', () => {
    seedAtNow(3);
    const ev = gatherEvidence(AGENT, { turns: 900, minutes: 900 }, NOW);
    expect(ev.sources.windowTurns).toBe(REPORT_WINDOW_MAX_TURNS);
    expect(ev.sources.windowMinutes).toBe(REPORT_WINDOW_MAX_MINUTES);
    expect(ev.sources.windowTruncated).toBe(true);
  });

  it('reads the seeded rows back at all — the stamp formats are the production ones', () => {
    seedAtNow(2);
    const ev = gatherEvidence(AGENT, {}, NOW);
    expect(ev.sources.turns.length).toBe(2);
    expect(ev.dominant.toolFailures.length).toBeGreaterThan(0);
    expect(ev.dominant.turnExits[0]).toEqual({ exitReason: 'brake', count: 2 });
  });
});

// ⚠ THE NUMBER ON THE PUBLIC PAGE IS THE NUMBER THE COLLECTOR APPLIED (final review, FR-3).
//
// `window.turns` is published in the attachment (`sources.windowTurns`) AND said to the agent
// in words ("this is the last N turns"). It was resolved and then never applied: `readTurns`
// bound its `LIMIT` to `COLLECTOR_CAPS.turns` and to nothing else, so `dojo_report
// {phase:"gather", turns:5}` answered `window.turns: 5` beside up to twenty turn entries. That
// is I1's defect class one field over — a bounded-looking window that is not the bound — and
// I1 was ruled Important.
//
// The two clauses below are the two directions, and BOTH are needed. The first alone would be
// satisfied by deleting the cap; the second alone is satisfied by the defect itself. What
// makes them bite is that the same body is seeded for both: one collector, one table, two asks,
// two different answers.
describe('the turn count the attachment PUBLISHES is the turn count the reader applied', () => {
  it('a five-turn ask returns five turns, not the standing twenty', () => {
    seedAtNow(COLLECTOR_CAPS.turns * 2);
    const ev = gatherEvidence(AGENT, { turns: 5 }, NOW);
    expect(ev.sources.windowTurns, 'the ask was inside the cap and must be honoured as asked').toBe(5);
    expect(
      ev.sources.turns.length,
      'the attachment claims a five-turn window and carries more than five turns',
    ).toBe(5);
  });

  it('...and the cap still binds when the ask is above it — the ask cannot raise the bound', () => {
    seedAtNow(COLLECTOR_CAPS.turns * 2);
    const ev = gatherEvidence(AGENT, { turns: 500 }, NOW);
    expect(ev.sources.windowTurns).toBe(REPORT_WINDOW_MAX_TURNS);
    expect(ev.sources.windowTruncated).toBe(true);
    expect(ev.sources.turns.length, 'an oversized ask reached past the collector cap')
      .toBe(COLLECTOR_CAPS.turns);
  });

  it('holds as an invariant across every ask, including no ask at all', () => {
    seedAtNow(COLLECTOR_CAPS.turns * 2);
    for (const req of [{}, { turns: 1 }, { turns: 5 }, { turns: 20 }, { turns: 500 },
      { turns: -3 }, { turns: Number.NaN }]) {
      const ev = gatherEvidence(AGENT, req, NOW);
      // Non-vacuity: an always-empty reader satisfies "at most" for free, and an always-empty
      // window is the exact defect this file was written to catch.
      expect(ev.sources.turns.length, JSON.stringify(req)).toBeGreaterThan(0);
      expect(
        ev.sources.turns.length,
        `${JSON.stringify(req)}: the attachment publishes ${ev.sources.windowTurns} turns and carries `
        + `${ev.sources.turns.length}`,
      ).toBeLessThanOrEqual(ev.sources.windowTurns);
    }
  });
});

// ⚠ THE BLOCK THE FIRST CUT DID NOT HAVE. Each clause seeds one row inside, one exactly on
// the boundary second, and one a single second outside — so a predicate that stopped binding
// (or bound in the wrong UNIT) changes the answer here and nowhere else in the suite.
describe('the window EXCLUDES what falls outside it, in every collector\'s own stamp format', () => {
  it('turns: the in-window and boundary rows come back, the outside row does not', () => {
    seedBoundary();
    const ev = gatherEvidence(AGENT, {}, NOW);
    expect(ev.sources.turns.length, 'a vacuous turns predicate returns all three').toBe(2);
  });

  it('model calls: TEXT-stamped, and the bound holds at the boundary second', () => {
    seedBoundary();
    const ev = gatherEvidence(AGENT, {}, NOW);
    expect(ev.sources.calls.length).toBe(2);
    // The outside row is the one seeded with input_tokens = 1.
    expect(ev.sources.calls.map(c => c.inputTokens).sort()).toEqual([2, 3]);
  });

  it('work: bound in epoch MILLISECONDS — a seconds-shaped bound would never bind', () => {
    seedBoundary();
    const ev = gatherEvidence(AGENT, {}, NOW);
    expect(ev.sources.work.length, 'a seconds-vs-milliseconds bound lets every row through').toBe(2);
  });

  it('tool failures: the streak that last fired before the window is left out', () => {
    seedBoundary();
    const ev = gatherEvidence(AGENT, {}, NOW);
    expect(ev.dominant.toolFailures.length).toBe(2);
  });

  it('audit rows: the stale row\'s path never reaches the bundle, let alone the sources', () => {
    seedBoundary();
    const ev = gatherEvidence(AGENT, {}, NOW);
    expect(JSON.stringify(ev.bundle)).toContain('taxes.pdf');
    expect(JSON.stringify(ev.bundle), 'an out-of-window audit row entered the bundle').not.toContain('last-tuesday.pdf');
  });

  it('tool calls: a call older than the window does not ride in wearing a null verdict', () => {
    seedBoundary();
    const ev = gatherEvidence(AGENT, {}, NOW);
    expect(ev.sources.toolCalls.length).toBe(2);
    // Both survivors are paired with their audit verdict, so neither is the stale one.
    expect(ev.sources.toolCalls.every(t => t.result === 'denied')).toBe(true);
  });

  it('a tighter ask moves the boundary — the window is the ASK, not a constant', () => {
    seedBoundary();
    // 30 minutes back from 12:00Z opens at 11:30Z, so only… nothing: every seeded row is
    // at or before 11:00Z. The same body, a different answer, is what "bounded" means.
    const ev = gatherEvidence(AGENT, { minutes: 30 }, NOW);
    expect(ev.sources.turns.length).toBe(0);
    expect(ev.sources.work.length).toBe(0);
    expect(ev.sources.calls.length).toBe(0);
  });
});

describe('the user content stays in the bundle and never reaches the telemetry sources', () => {
  // ⚠ THE NON-VACUITY GUARD COMES FIRST, AND IT IS NOT CEREMONY. The first cut of this file
  // seeded no `messages` row, so `toolCalls` was empty, so every "does not contain" clause
  // below was true about an object that had no tool facts in it at all — and the mutant that
  // copies `audit_log.target` into the `result` field SURVIVED, green, 11/11. A privacy
  // assertion over an empty collection is the most confident kind of nothing.
  it('has tool-call facts to be private ABOUT — the clauses below are not vacuous', () => {
    seedAtNow(1);
    const ev = gatherEvidence(AGENT, {}, NOW);
    expect(ev.sources.toolCalls.length).toBeGreaterThan(0);
    // The `call_id` ↔ `tool_use.id` join landed: this fact came from the audit row.
    expect(ev.sources.toolCalls[0]).toMatchObject({ name: 'file_read', result: 'denied' });
  });

  it('keeps audit_log.target out of `sources` and in the local bundle', () => {
    seedAtNow(2);
    const ev = gatherEvidence(AGENT, {}, NOW);
    expect(ev.sources.toolCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev.bundle)).toContain('taxes.pdf');
    expect(
      JSON.stringify(ev.sources),
      'a column carrying the user\'s file path reached the object the attachment is built from',
    ).not.toContain('taxes.pdf');
  });

  it('keeps the platform-authored detail string out of `sources` too', () => {
    seedAtNow(1);
    const ev = gatherEvidence(AGENT, {}, NOW);
    // M5: this clause's own non-vacuity guard, not its sibling's.
    expect(ev.sources.toolCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev.bundle)).toContain('File not found');
    expect(JSON.stringify(ev.sources)).not.toContain('File not found');
  });

  it('carries the SIZE of a path-valued argument and never the path', () => {
    seedAtNow(1);
    const shape = gatherEvidence(AGENT, {}, NOW).sources.toolCalls[0].argShape;
    // `path` is a declared property of `file_read`, so the key survives as itself.
    expect(shape).toEqual([{ key: 'path', type: 'string', bytes: JSON.stringify(SECRET_PATH).length }]);
    expect(JSON.stringify(shape)).not.toContain('taxes');
  });
});
