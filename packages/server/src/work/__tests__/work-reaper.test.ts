// PHASE-2 T9 — ONE REAPER, PER-KIND DEADLINES, AND THE STORM INVARIANTS ON THE SPINE.
//
// Written RED, before `work/work-reaper.ts` existed. Four properties, each of which the tree
// had as a convention scattered across files rather than as a thing a test could read:
//
//   1. THE DEADLINE TABLE IS COMPLETE AND CARRIED. Thirteen distinct age cliffs govern this
//      platform's obligations (PHASE-2.md PINNED §4 — "13 distinct deadlines, not nine";
//      a table with nine rows leaves four deadlines outside the one reaper). Every row
//      carries the constant it was CARRIED FROM, and this file re-derives each value against
//      that constant's own site at HEAD, so a future edit to either copy fails here (#14: a
//      threshold that is carried is not a threshold that is invented).
//
//   2. THE CHOKE POINT IS EXPLICIT. Today it is accidental — `getPendingEngineEvent` happens
//      to be the one function every consumer funnels through. The property is now stated:
//      every obligation sweep in the tree is registered in `REAPER_KINDS`, and no obligation
//      sweep may own a `setInterval` of its own.
//
//   3. THE STORM INVARIANTS ARE LAW, ON THE SPINE. "Self-wakes stand down completely while
//      any human conversation waits" and "unserved selection is freshness-bounded" were two
//      comments and one literal inside a finder. They are now a predicate over `work` and a
//      named deadline, and the reaper obeys the same law the runtime drain does.
//
//   4. THE DRAIN'S BOUND SURVIVES A RESTART. The `stuck` counters were `Map`s in one
//      process, so a crash loop reset the storm protection to zero on every boot — which is
//      the upgrade-day storm hazard by another name. The count is DERIVED from `turns`, the
//      spine's own record of what the agent did, so there is nothing to lose.
//
// ⚠ WHY NOT `work.attempts` (the collision T8c2 named). PHASE-2.md T9 Step 2 as written says
// the drain counters become `work.attempts`. `single-writer-conformance.test.ts` PART C
// measured that column and DECIDED it: `work.attempts` IS the recurrence fire count, with one
// writer and four readers all aliasing it to `run_count`. Putting a retry count in the same
// integer would end the first retried `after_count` schedule early. So the retry fact gets a
// home that is not a column at all — see property 4 — and this file records the reasoning
// where the next reader of that plan step will find it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-work-reaper-test', 'dojo.db'),
  };
});

import {
  DEADLINES, DEADLINE_IDS, REAPER_KINDS, REAPER_BASE_TICK_MS,
  humanAsksOpen, selfWakeStandDown, endedTurnsSince, drainStuck,
} from '../work-reaper.js';

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SRC = path.join(REPO, 'packages/server/src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

// ════════════════════════════════════════════════════════════════════════════════
// 1. THE DEADLINE TABLE — thirteen rows, each carried from its own site
// ════════════════════════════════════════════════════════════════════════════════

describe('T9 — the per-kind deadline table has all THIRTEEN cliffs, each with its reason', () => {
  it('thirteen ids, no more and no fewer', () => {
    expect(DEADLINE_IDS).toHaveLength(13);
    expect(Object.keys(DEADLINES).sort()).toEqual([...DEADLINE_IDS].sort());
  });

  it('every row states WHY it exists and WHERE its value came from', () => {
    for (const id of DEADLINE_IDS) {
      const d = DEADLINES[id];
      expect(d.id, `${id}: id must match its key`).toBe(id);
      expect(d.ms, `${id}: a deadline is a positive duration`).toBeGreaterThan(0);
      // A reason is prose a person can judge, not a restatement of the name.
      expect(d.reason.length, `${id}: no reason written`).toBeGreaterThan(40);
      // Provenance names a file. #14: "a count with no command beside it is a rumour", and
      // the same is true of a threshold with no site beside it.
      expect(d.carriedFrom, `${id}: no provenance`).toMatch(/\.ts\b/);
    }
  });

  // THE ANTI-DRIFT CLAUSE. Each value is re-derived from the constant it was carried from,
  // by reading that file at HEAD. Two copies of one number is exactly the disease this
  // phase deletes, so where a constant still exists the table does not restate it — it
  // asserts equality, and this test is what makes that assertion true rather than hopeful.
  const constantAt = (rel: string, name: string): number => {
    // Values in this tree are written both as plain numbers and as products
    // (`5 * 60 * 1000`), so the extractor reads the whole right-hand side and multiplies it
    // out. Anything that is not a product of integer literals is refused rather than
    // guessed at — a provenance check that quietly accepted an expression it could not read
    // would be worse than none.
    const m = new RegExp(`(?:const|export const)\\s+${name}\\s*(?::\\s*number\\s*)?=\\s*([0-9_ *]+);`)
      .exec(read(rel));
    if (!m) throw new Error(`${name} not found in ${rel} — the deadline table's provenance is stale`);
    return m[1].split('*').reduce((acc, part) => acc * Number(part.replace(/_/g, '').trim()), 1);
  };

  it('SELF-TEST: the provenance extractor reads both spellings and refuses neither silently', () => {
    expect(constantAt('agent/destructive-gate.ts', 'APPROVAL_TTL_MINUTES')).toBe(60);
    expect(constantAt('agent/runtime.ts', 'STUCK_AGENT_CHECK_MS')).toBe(300_000);
    expect(() => constantAt('agent/runtime.ts', 'NO_SUCH_CONSTANT_T9')).toThrow(/provenance is stale/);
  });

  it('the five surviving named constants still hold the value the table carries', () => {
    expect(DEADLINES.approval_stale_pending.ms)
      .toBe(constantAt('agent/destructive-gate.ts', 'STALE_PENDING_MINUTES') * 60_000);
    expect(DEADLINES.approval_ttl.ms)
      .toBe(constantAt('agent/destructive-gate.ts', 'APPROVAL_TTL_MINUTES') * 60_000);
    expect(DEADLINES.stuck_agent_threshold.ms)
      .toBe(constantAt('agent/runtime.ts', 'STUCK_AGENT_THRESHOLD_MINUTES') * 60_000);
    expect(DEADLINES.engine_event_expiry.ms)
      .toBe(constantAt('agent/v2/counterparty.ts', 'ENGINE_EVENT_EXPIRY_HOURS') * 3_600_000);
    expect(DEADLINES.stale_request.ms)
      .toBe(constantAt('scheduler/runner.ts', 'STALE_REQUEST_HOURS') * 3_600_000);
  });

  it('the three RENAMED constants still hold their pre-Phase-2 values', () => {
    // `PARK_TTL_MINUTES` / `PARK_MAX_AGE_DAYS` (a2a-transport.ts) and `STALE_AFTER_DAYS`
    // (memory/open-loops.ts) were deleted with their modules by T4 and T7, which carried the
    // VALUES onto the spine under new names. PINNED §4 named the old sites; this clause is
    // how the table proves it followed the value rather than re-invented it.
    expect(DEADLINES.join_ttl.ms).toBe(constantAt('work/store.ts', 'JOIN_TTL_MINUTES') * 60_000);
    expect(DEADLINES.join_max_age.ms).toBe(constantAt('work/store.ts', 'JOIN_MAX_AGE_DAYS') * 86_400_000);
    expect(DEADLINES.commitment_aging.ms).toBe(constantAt('work/store.ts', 'COMMITMENT_AGING_DAYS') * 86_400_000);
  });

  it('the two in-function literals are still the literals the table carries', () => {
    // `CLOSE_OUT_IDLE_MINUTES` is declared INSIDE a function in loop.ts and
    // `STALE_TASK_WINDOW_MINUTES` at module scope; both are read as written text rather than
    // imported, because importing `loop.ts` into a unit test drags the whole engine in.
    expect(read('agent/v2/loop.ts')).toMatch(/const CLOSE_OUT_IDLE_MINUTES = 10;/);
    expect(DEADLINES.close_out_idle.ms).toBe(10 * 60_000);
    expect(read('agent/v2/loop.ts')).toMatch(/const STALE_TASK_WINDOW_MINUTES = 30;/);
    expect(DEADLINES.stale_task_window.ms).toBe(30 * 60_000);
  });

  it('the wake freshness bound is the 45-minute literal in the finder itself', () => {
    // THE STORM BOUND. `findUnservedTerminalWake` carries it as a SQL literal because the
    // predicate is where it has to be true; the table names it so the one reaper knows the
    // cliff exists. Both are asserted, so neither can move alone.
    expect(read('agent/v2/counterparty.ts')).toMatch(/unixepoch\('now', '-45 minutes'\)/);
    expect(DEADLINES.wake_freshness.ms).toBe(45 * 60_000);
  });

  it('the two CADENCES in the table are the periods their own timers ran at', () => {
    expect(DEADLINES.stuck_agent_check.ms)
      .toBe(constantAt('agent/runtime.ts', 'STUCK_AGENT_CHECK_MS'));
    expect(DEADLINES.join_ttl_sweep.ms).toBe(10 * 60_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2. THE SINGLE CHOKE POINT — stated, not accidental
// ════════════════════════════════════════════════════════════════════════════════

describe('T9 — every obligation sweep routes through the one reaper', () => {
  it('each registered kind declares its cadence AND where that cadence came from', () => {
    expect(REAPER_KINDS.length).toBeGreaterThan(0);
    for (const k of REAPER_KINDS) {
      expect(k.everyMs, `${k.id}: cadence must be positive`).toBeGreaterThan(0);
      // NO INVENTED CADENCE (#14). Every period is a multiple of the base tick and names the
      // clock it was taken from.
      expect(k.everyMs % REAPER_BASE_TICK_MS, `${k.id}: ${k.everyMs} is not a multiple of the base tick`).toBe(0);
      expect(k.cadenceFrom.length, `${k.id}: no cadence provenance`).toBeGreaterThan(20);
      expect(typeof k.run).toBe('function');
    }
  });

  it('kind ids are unique — one owner per job', () => {
    const ids = REAPER_KINDS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // THE CHOKE-POINT PROPERTY ITSELF. The sweeps the reaper owns must not ALSO be driven by a
  // timer of their own; two clocks for one sweep is the duplication this phase deletes.
  it('no obligation sweep the reaper owns is still called from a setInterval elsewhere', () => {
    const ownedCallees = [
      'sweepExpiredJoins',
      'sweepStaleApprovals',
      'sweepStaleOverrideRequests',
      'sweepStaleUserVerdictRequests',
      'abandonUnservableAsks',
    ];
    // Files that legitimately name these: the reaper (the owner), the definitions themselves,
    // the boot path (a one-shot, not a clock), and tests.
    const offenders: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (['node_modules', 'dist', '__tests__', 'migrations'].includes(e.name)) continue;
          out.push(...walk(fp));
        } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(fp);
      }
      return out;
    };
    for (const f of walk(SRC)) {
      const rel = path.relative(SRC, f).split(path.sep).join('/');
      if (rel === 'work/work-reaper.ts') continue;
      const src = fs.readFileSync(f, 'utf8');
      // Only the INTERVAL shape is an offence: a boot-time one-shot call is fine.
      for (const m of src.matchAll(/setInterval\(([\s\S]{0,700}?)\},\s*[^)]*\)/g)) {
        for (const callee of ownedCallees) {
          if (m[1].includes(callee)) offenders.push(`${rel}: setInterval drives ${callee}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('PLANTED FAULT: a second timer for an owned sweep would be caught', () => {
    // The scanner's own shape, proven against the text the offence would look like.
    const planted = "setInterval(() => { void sweepExpiredJoins(); }, 600000)";
    const hit = [...planted.matchAll(/setInterval\(([\s\S]{0,700}?)\},\s*[^)]*\)/g)]
      .some((m) => m[1].includes('sweepExpiredJoins'));
    expect(hit).toBe(true);
    const innocent = "// the reaper owns sweepExpiredJoins now";
    expect([...innocent.matchAll(/setInterval\(([\s\S]{0,700}?)\},\s*[^)]*\)/g)].length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 + 4. THE STORM LAW AND THE RESTART-SAFE BOUND, against a real database
// ════════════════════════════════════════════════════════════════════════════════

let db: Database.Database;

const AGENT = 'agent-t9';

beforeEach(() => {
  db = new Database(':memory:');
  mockDb.current = db;
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, status TEXT, session_started_at TEXT);
    CREATE TABLE work (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent_id TEXT NOT NULL,
      state TEXT NOT NULL, root_id TEXT NOT NULL DEFAULT '',
      opened_at INTEGER NOT NULL, closed_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE turns (
      agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT,
      PRIMARY KEY (agent_id, turn_number)
    );
  `);
  db.prepare("INSERT INTO agents VALUES (?, 'idle', '1970-01-01')").run(AGENT);
});

afterEach(() => {
  mockDb.current = null;
  db.close();
});

const seedAsk = (id: string, state: string, openedAt = 1_000): void => {
  db.prepare("INSERT INTO work (id, kind, agent_id, state, opened_at) VALUES (?, 'ask', ?, ?, ?)")
    .run(id, AGENT, state, openedAt);
};

describe('T9 — the storm law reads WORK STATE: self-wakes stand down while a human waits', () => {
  it('no open ask -> no stand-down', () => {
    expect(humanAsksOpen(AGENT)).toBe(0);
    expect(selfWakeStandDown(AGENT)).toEqual({ standDown: false, humanAsksOpen: 0 });
  });

  it('ONE open ask is enough — the law is "completely", not "mostly"', () => {
    seedAsk('a1', 'open');
    expect(humanAsksOpen(AGENT)).toBe(1);
    expect(selfWakeStandDown(AGENT).standDown).toBe(true);
  });

  it('a CLAIMED ask is being served right now and is not a person waiting', () => {
    // The requirement is "while any human conversation WAITS". A claimed ask has a turn on
    // it — that turn IS the service — so counting it would stand the drain down forever.
    seedAsk('a1', 'claimed');
    expect(humanAsksOpen(AGENT)).toBe(0);
  });

  it.each(['done', 'failed', 'abandoned', 'paused', 'blocked', 'on_deck'])(
    'a %s ask is not a waiting human either', (state) => {
      seedAsk(`a-${state}`, state);
      expect(humanAsksOpen(AGENT)).toBe(0);
    });

  it('the law is PER AGENT — another agent\'s waiting human does not freeze this one', () => {
    db.prepare("INSERT INTO agents VALUES ('other', 'idle', '1970-01-01')").run();
    db.prepare("INSERT INTO work (id, kind, agent_id, state, opened_at) VALUES ('o1','ask','other','open',1)").run();
    expect(humanAsksOpen(AGENT)).toBe(0);
    expect(humanAsksOpen('other')).toBe(1);
  });

  it('only ASKS count — a task, a project or an occurrence is board work, not a person waiting', () => {
    for (const kind of ['task', 'project', 'occurrence', 'commitment']) {
      db.prepare("INSERT INTO work (id, kind, agent_id, state, opened_at) VALUES (?, ?, ?, 'open', 1)")
        .run(`k-${kind}`, kind, AGENT);
    }
    expect(humanAsksOpen(AGENT)).toBe(0);
  });

  it('FAIL-CLOSED: an unreadable spine stands the self-wake DOWN, it does not let it run', () => {
    // The direction of error is the whole design. If the reaper cannot tell whether a person
    // is waiting, the safe answer is silence — the 2026-07-23 storm is what the other
    // direction costs.
    db.exec('DROP TABLE work');
    expect(selfWakeStandDown(AGENT)).toEqual({ standDown: true, humanAsksOpen: -1 });
  });
});

describe('T9 — the drain bound is DERIVED from `turns`, so a restart cannot reset it', () => {
  const endTurn = (n: number, endedAt: string): void => {
    db.prepare("INSERT INTO turns (agent_id, turn_number, started_at, ended_at) VALUES (?, ?, ?, ?)")
      .run(AGENT, n, endedAt, endedAt);
  };
  // 2026-07-29 12:00:00Z = 1785326400
  const T = (offsetSec: number): string => new Date((1785326400 + offsetSec) * 1000)
    .toISOString().replace('T', ' ').replace(/\..*$/, '');
  const HEAD_MS = 1785326400 * 1000;

  it('no ended turn since the head arrived -> stuck 0', () => {
    expect(endedTurnsSince(AGENT, HEAD_MS)).toBe(0);
    expect(drainStuck(AGENT, HEAD_MS)).toBe(0);
  });

  it('the pass that FOUND the head is not a failure to advance (1 turn -> stuck 0)', () => {
    endTurn(1, T(10));
    expect(endedTurnsSince(AGENT, HEAD_MS)).toBe(1);
    expect(drainStuck(AGENT, HEAD_MS)).toBe(0);
  });

  it('the second pass on the same head is stuck 1, the third is stuck 2 — the drain\'s own ladder', () => {
    endTurn(1, T(10)); endTurn(2, T(20));
    expect(drainStuck(AGENT, HEAD_MS)).toBe(1);
    endTurn(3, T(30));
    expect(drainStuck(AGENT, HEAD_MS)).toBe(2);
  });

  it('turns that ended BEFORE the head existed do not count against it', () => {
    endTurn(1, T(-600)); endTurn(2, T(-300));
    expect(drainStuck(AGENT, HEAD_MS)).toBe(0);
  });

  it('an OPEN turn is not an ended one — the in-flight turn has not failed yet', () => {
    db.prepare("INSERT INTO turns (agent_id, turn_number, started_at, ended_at) VALUES (?, 9, ?, NULL)")
      .run(AGENT, T(5));
    expect(endedTurnsSince(AGENT, HEAD_MS)).toBe(0);
  });

  it('THE POINT: the count survives a process restart, because it was never in the process', () => {
    endTurn(1, T(10)); endTurn(2, T(20)); endTurn(3, T(30));
    const before = drainStuck(AGENT, HEAD_MS);
    // A restart clears every Map in the runtime. It cannot clear `turns`.
    expect(drainStuck(AGENT, HEAD_MS)).toBe(before);
    expect(before).toBe(2);
  });

  it('another agent\'s turns are not this agent\'s drain passes', () => {
    db.prepare("INSERT INTO turns (agent_id, turn_number, started_at, ended_at) VALUES ('other', 1, ?, ?)")
      .run(T(10), T(10));
    expect(endedTurnsSince(AGENT, HEAD_MS)).toBe(0);
  });
});
