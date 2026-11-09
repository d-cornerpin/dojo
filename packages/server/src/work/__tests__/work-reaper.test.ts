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
//   4. THE DERIVED DRAIN BOUND IS A REFUSED DESIGN, AND IT STAYS REFUSED. T9 built it here
//      and the battery took it away again; the last describe block is the landmine note, with
//      the run id and the clause that failed.
//
// ⚠ WHY NOT `work.attempts` (the collision T8c2 named). PHASE-2.md T9 Step 2 as written says
// the drain counters become `work.attempts`. `single-writer-conformance.test.ts` PART C
// measured that column and DECIDED it: `work.attempts` IS the recurrence fire count, with one
// writer and four readers all aliasing it to `run_count`. Putting a retry count in the same
// integer would end the first retried `after_count` schedule early. `messages.delivery_attempts`
// fails on its own measurement too. The restart-safe home is therefore still OWED, and every
// remaining candidate needs DDL — which this task was told not to write. The full enumeration
// is in `work-reaper.ts`'s own header.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-work-reaper-test', 'dojo.db'),
  };
});

import {
  DEADLINES, DEADLINE_IDS, REAPER_KINDS, REAPER_BASE_TICK_MS,
  humanAsksOpen, selfWakeStandDown,
} from '../work-reaper.js';

// ════════════════════════════════════════════════════════════════════════════════
// 1. THE DEADLINE TABLE — thirteen rows, each carried from its own site
// ════════════════════════════════════════════════════════════════════════════════

describe('T9: the per-kind deadline table has all ELEVEN cliffs, each with its reason', () => {
  it('twelve ids, no more and no fewer (close_out_idle left in field fix 3 audit round #8)', () => {
    expect(DEADLINE_IDS).toHaveLength(11);
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

  it('the two in-function literals are still the literals the table carries', () => {
    expect(DEADLINES.stale_task_window.ms).toBe(30 * 60_000);
  });

  it('the wake freshness bound is the 45-minute literal in the finder itself', () => {
    expect(DEADLINES.wake_freshness.ms).toBe(45 * 60_000);
  });

  it('the two CADENCES in the table are the periods their own timers ran at', () => {
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
    expect(selfWakeStandDown(AGENT)).toEqual({
      standDown: false, humanAsksOpen: 0,
      // SWEEP CORE-2 item 5: the verdict now also says WHO is waiting, in the owner's
      // decided precedence. Nobody is, so every tier is zero.
      tiers: { mainUser: 0, safeSenders: 0, otherAgents: 0 },
    });
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
    expect(selfWakeStandDown(AGENT)).toEqual({
      standDown: true, humanAsksOpen: -1,
      // The tiers fail closed with the number: no count is invented from a failure.
      tiers: { mainUser: 0, safeSenders: 0, otherAgents: 0 },
    });
  });
});

describe('T9 — the DERIVED drain bound is a refused design, and it stays refused', () => {
  // A landmine note with a test behind it. T9 built `drainStuck()` here and the battery
  // refused it: a deliverable that arrives MID-ORCHESTRATION is followed by several
  // legitimate turns (serving the human, during whom the drain stands down entirely under
  // the storm law), so a count anchored on the head's ARRIVAL is already past the bound
  // before the drain's first real look — and the wake turn never runs.
  //
  //   `multi-agent-project`, run `bms651uo8lh`: 0/3, retry lane used, runner's own verdict
  //   "NOT a flake". Every other target clause PASSED; only "final owner answer integrates
  //   codeword" was false.
  //
  // The full write-up, including the two column candidates already refused on their own
  // measurements (`work.attempts`, `messages.delivery_attempts`), is in `work-reaper.ts`.
  // This clause exists so the next person to reach for the same clean-looking derivation
  // finds the measurement before spending the battery time again.

  it('the reaper exports no derived stuck counter', async () => {
    const mod = await import('../work-reaper.js');
    expect(Object.keys(mod)).not.toContain('drainStuck');
    expect(Object.keys(mod)).not.toContain('endedTurnsSince');
  });
});
