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
  humanAsksOpen, selfWakeStandDown,
} from '../work-reaper.js';
// PHASE-6 GUARD-AUDIT 2026-08-04: the shared engine-corpus derivation (driver + step
// packages), for the ONE deadline literal below that is declared inside the turn body.
import { engineText } from '../../agent/v2/__tests__/engine-sources.js';

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
    // PHASE-6 T10 moved this constant to the one stuck-threshold table, and THIS CLAUSE IS
    // HOW THE MOVE WAS FOUND — it went red with "provenance is stale", named the file, and
    // was repaired to the new site rather than deleted. The table now READS the constant, so
    // the assertion is an identity; it stays because a future site change re-arms it.
    expect(DEADLINES.stuck_agent_threshold.ms)
      .toBe(constantAt('agent/stuck-thresholds.ts', 'STUCK_AGENT_THRESHOLD_MINUTES') * 60_000);
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
    // PHASE-6 GUARD-AUDIT 2026-08-04: `CLOSE_OUT_IDLE_MINUTES` is declared at loop.ts:2296,
    // INSIDE `runV2TurnBody` (lines 1013-9362), so it travels into `agent/v2/steps/<name>/`
    // with its tranche. Corpus widened from the driver alone to THE ENGINE (driver + every
    // step package). Not weaker: the literal must still exist and still be exactly 10; the
    // widening only lets the clause find it wherever the cut put it, instead of going red for
    // a reason (the file moved) that has nothing to do with the deadline it guards.
    expect(engineText()).toMatch(/const CLOSE_OUT_IDLE_MINUTES = 10;/);
    expect(DEADLINES.close_out_idle.ms).toBe(10 * 60_000);
    // PHASE-6 GUARD-AUDIT 2026-08-04: `STALE_TASK_WINDOW_MINUTES` is declared at loop.ts:560 —
    // MODULE LEVEL, outside `runV2TurnBody` — so no tranche moves it and this clause CANNOT go
    // quiet from a step cut. Left reading the driver by path deliberately: naming the one file
    // that actually holds it is the narrower and therefore stronger corpus, and this module
    // must not be a reason to widen a clause past its subject.
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

  // ── RE-EXPRESSED AT PHASE-2 T10 (RULING 5), NOT WEAKENED ──
  //
  // The two clauses this replaces pinned the LITERAL Map expressions
  // (`prev && prev.head === head ? prev.stuck + 1 : 0`). RULING 5 ordered that storage
  // moved: the Map died with the process, so a crash loop reset this bound to zero on every
  // boot. Pinning a Map read would now pin the defect.
  //
  // What the old clauses were protecting is unchanged and is what these assert: BOTH drains
  // still bound themselves on a CONSECUTIVE-PASS ladder, both still name their own drain, and
  // the refused derivation is still absent from the file. The ladder's arithmetic — first
  // sighting 0, same head +1, new head back to 0 — moved to `agent/drain-state.ts` where it
  // is asserted BEHAVIOURALLY by `agent/__tests__/drain-state.test.ts` (12 clauses, including
  // the restart), which is a stronger check than the source-text match it replaces.
  it('both drains in runtime.ts bound themselves on the consecutive-pass ladder, and say why in place', () => {
    const rt = read('agent/runtime.ts');
    expect(rt).toMatch(/bumpDrainLadder\(agentId, 'unserved_wake', head\)/);
    expect(rt).toMatch(/bumpDrainLadder\(agentId, 'human_conversation', String\(head\)\)/);
    expect(rt).toMatch(/THE BATTERY REFUSED IT/);
  });

  it('the refused derivation is not back in runtime.ts under any name', () => {
    // The landmine itself: the clean-looking shape the battery refused.
    //
    // Comments are stripped first, deliberately. The landmine NOTE names the refused
    // derivation — that is the point of a landmine note — so a raw text match would either
    // fail on the warning itself or force the warning to be written without its own name.
    // The question is whether the derivation is back in the CODE.
    const code = read('agent/runtime.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    expect(code).not.toMatch(/endedTurnsSince/);
    expect(code).not.toMatch(/drainStuck\s*\(/);
    // POSITIVE CONTROL: the stripper did not just blank the file.
    expect(code).toMatch(/bumpDrainLadder/);
  });

  it('the ladder is DURABLE — no module-scope Map holds a drain bound any more', () => {
    // The property RULING 5 bought. A Map here is the crash-loop amnesia coming back.
    const rt = read('agent/runtime.ts');
    const ts = read('agent/turn-state.ts');
    expect(rt).not.toMatch(/new Map<string, \{ head: string; stuck: number \}>/);
    expect(ts).not.toMatch(/new Map<string, \{ rowid: number; stuck: number \}>/);
    expect(read('agent/drain-state.ts')).toMatch(/INSERT INTO drain_state/);
  });

  it('and the storm law it sits beside is NOW read from the spine — this clause\'s title came true', () => {
    // NEGATIVE CONTROL for the two clauses above: they must not pass by the drain block
    // having been deleted wholesale.
    //
    // ⚠ PHASE-6 T10 Step 1d — RE-POINTED, AND THE OLD PIN WAS ASSERTING THE DEFECT.
    // This clause was written to say the storm law is "read from the spine" and then pinned
    // `getWaitingHumanConversations(agentId).length` — which is not the spine at all: it is
    // a CONVERSATION count off `messages`, deduped by conversation key, logged under a field
    // called `humanAsksOpen`. The title was true of the intent and false of the code, and
    // PHASE-5's exit battery is what caught the gap (`humanAsksOpen=0` against a spine
    // holding fifteen). The drain now asks `selfWakeStandDown`, which IS the spine predicate
    // this file exports, so the two halves finally say the same thing.
    //
    // The pin is kept, not deleted: it is what made the change impossible to make quietly,
    // and it does the same job for the next one.
    const rt = read('agent/runtime.ts');
    expect(rt).toMatch(/const \{ standDown, humanAsksOpen: openAsks, tiers \} = selfWakeStandDown\(agentId\)/);
    expect(rt).toMatch(/humanAsksOpen: openAsks,/);
    // …and the conversation reader is STILL here, for the drain that needs the head itself.
    expect(rt).toMatch(/const waiting = getWaitingHumanConversations\(agentId\)/);
  });
});
