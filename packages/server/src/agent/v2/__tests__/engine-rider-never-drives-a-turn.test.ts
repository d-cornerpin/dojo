// PHASE-2 T10H — AN ENGINE RIDER MUST NEVER DRIVE ITS OWN TURN.
//
// ── THE REQUIREMENT, IN THE PLATFORM'S OWN WORDS ──
// Ten production sites write an engine row whose content is meant to be SEEN during a turn
// that is happening anyway — a thrash steer, a delegation hint, an owed-work interrupt, a
// promise floor, an a2a-handoff floor, an auto-scaffold prompt, the fan-out join compile
// order, and every inter-agent awareness notice. Each one says so in a comment, and two say
// it exactly:
//
//   loop.ts   "conv_key sentinel 'engine-steer' keeps it un-selectable as a pending event"
//   agent-notice.ts
//             "without a non-NULL conv_key every awareness notice would be mistaken for a
//              pending engine EVENT and drive a spurious engine turn"
//
// requirement preserved: content that RIDES a turn is never itself the reason for one.
//
// ── WHY THIS FILE EXISTS (measured at `e04850f`, 2026-07-30) ──
// PHASE-2 T9 re-pointed `DELIVERABLE_ENGINE_EVENT_WHERE` from `conv_key IS NULL` onto
// `served_by_turn IS NULL` — correctly, because `conv_key` is conversation IDENTITY and the
// claim had no business living there. But the sentinel was the ONLY thing excluding riders,
// and nothing took over that job: the predicate's own `origin_intent NOT IN (...)` list names
// three values (`thrash_gate`, `hint`, `system`), of which exactly ONE is ever written. So
// after T9 the other rider intents are selectable as pending engine events while ten comments
// still claim they are not.
//
// The consequence is silent, which is why it survived four sittings: the runtime drain's
// engine arm (`runtime.ts:767`) calls `underWakeBudget` and logs NOTHING, so a rider left
// unclaimed at the end of a session re-arms a wake on every turn end until the per-agent wake
// budget trips at 30. The trip DOES log, at error level — and that one product event is the
// whole of `fanout-serves-all-pieces`' recorded red: `NO_WAKE_CHURN` reads it as `[BREAKER]`
// and `NO_UNHANDLED_ERROR` reads the same line. Run `bms6sz1vbdt` left the proof on the box:
// one `origin_intent='fanout_join'` row, `conv_key='engine-steer'`, `served_by_turn` NULL,
// returned by `getPendingEngineEvent` — the sentinel excluding nothing.
//
// ── WHY THE FIX IS AN INTENT SET AND NOT A NEW COLUMN OR A NEW LANE ──
// Measured before choosing (#14/#15): `lane` is a hard CHECK of three values, so a fourth
// lane is a table rebuild plus every lane reader; `display_kind` is `engine-note` for all 399
// events-lane rows and distinguishes nothing; and adding a column in the phase whose job is
// deletion is the disease this overhaul exists to cure. The predicate ALREADY carries an
// `origin_intent NOT IN (...)` exclusion — this change does not introduce that mechanism, it
// moves the list to one owner beside the writer and makes it COMPLETE by measurement.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { getPendingEngineEvent } from '../counterparty.js';
import { ENGINE_RIDER_INTENTS } from '../engine-riders.js';

const AGENT = 'agent-alpha';
const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');

/** A subset of migrations 099/112/131/133's `messages` shape: the columns the pending-event
 *  predicate and its gates read. Deliberately a subset — `work-spine-schema.test.ts` is where
 *  the schema itself is asserted; this file seeds rows. */
function seed(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, session_started_at TEXT);
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      lane TEXT NOT NULL DEFAULT 'owner',
      origin_intent TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      content TEXT NOT NULL,
      conv_key TEXT,
      served_by_turn INTEGER,
      swept_at INTEGER,
      retired_at INTEGER,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      task_id TEXT, run_id TEXT, root_kind TEXT, root_id TEXT,
      source_agent_id TEXT, a2a_thread_id TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE work (
      id TEXT PRIMARY KEY, kind TEXT, state TEXT, agent_id TEXT,
      root_kind TEXT, root_id TEXT, opened_at INTEGER, closed_at INTEGER
    );
  `);
  db.prepare(`INSERT INTO agents (id, session_started_at) VALUES (?, '1970-01-01')`).run(AGENT);
  return db;
}

/** An engine row on the events lane, unclaimed and inside every eligibility gate — i.e. the
 *  ONLY thing that can decide whether it is pending is the rider exclusion. */
function insertEventsRow(db: Database.Database, id: string, originIntent: string, convKey: string | null): void {
  db.prepare(
    `INSERT INTO messages (id, agent_id, lane, origin_intent, role, content, conv_key, created_at)
     VALUES (@id, @agent, 'events', @intent, 'user', @content, @convKey, (unixepoch('now') * 1000))`,
  ).run({ id, agent: AGENT, intent: originIntent, content: `body of ${id}`, convKey });
}

describe('PHASE-2 T10H — an engine RIDER never drives its own turn', () => {
  beforeEach(() => { mockDb.current = seed(); });

  // ── THE CLAUSE THAT WAS RED BEFORE THE FIX ──
  // Every rider intent, one row at a time, each on its own database. Written per-intent rather
  // than as one row so the failure names the intent that is not excluded instead of reporting
  // "something is pending".
  for (const intent of ENGINE_RIDER_INTENTS) {
    it(`a '${intent}' rider is NOT a pending engine event`, () => {
      insertEventsRow(mockDb.current!, `rider-${intent}`, intent, null);
      expect(getPendingEngineEvent(AGENT)).toBeNull();
    });
  }

  // ── THE NEGATIVE CONTROL, so the fix cannot pass by excluding everything ──
  // Without this clause a predicate of `AND 0` would make every clause above green while
  // silently killing every reminder, schedule fire and tracker assignment on the box.
  it('a genuine deliverable engine event is STILL pending — the exclusion is not a blanket', () => {
    for (const intent of ['scheduler', 'tracker', 'reminder', 'healer', 'completion_report', 'a2a_request', 'spawn_kickoff', 'pm_review']) {
      mockDb.current = seed();
      insertEventsRow(mockDb.current, `deliverable-${intent}`, intent, null);
      const pending = getPendingEngineEvent(AGENT);
      expect(pending, `'${intent}' must still be able to drive its own turn`).not.toBeNull();
      expect(pending!.id).toBe(`deliverable-${intent}`);
    }
  });

  it('an engine event with NO origin_intent at all is still pending (the pre-112 shape)', () => {
    insertEventsRow(mockDb.current!, 'legacy-null-intent', null as unknown as string, null);
    expect(getPendingEngineEvent(AGENT)?.id).toBe('legacy-null-intent');
  });

  // ── THE EXCLUSION DOES NOT DEPEND ON THE SENTINEL, WHICH IS THE POINT ──
  // The rider rows above carry `conv_key = NULL`. This clause proves the same row is excluded
  // whether or not the sentinel is present, i.e. the requirement now survives the column's
  // deletion. Before the fix the sentinel was load-bearing and this pair disagreed.
  it('a rider is excluded with the conv_key sentinel AND without it — the column is no longer load-bearing', () => {
    insertEventsRow(mockDb.current!, 'rider-with-sentinel', 'fanout_join', 'engine-steer');
    expect(getPendingEngineEvent(AGENT)).toBeNull();
    mockDb.current = seed();
    insertEventsRow(mockDb.current, 'rider-without-sentinel', 'fanout_join', null);
    expect(getPendingEngineEvent(AGENT)).toBeNull();
  });

  it('the oldest DELIVERABLE wins even when riders are older — riders are skipped, not queued behind', () => {
    const db = mockDb.current!;
    insertEventsRow(db, 'old-rider', 'thrash_drift', 'engine-steer');
    insertEventsRow(db, 'younger-deliverable', 'scheduler', null);
    expect(getPendingEngineEvent(AGENT)?.id).toBe('younger-deliverable');
  });
});

// ── THE GATE THAT STOPS THE NEXT RIDER RE-OPENING THIS HOLE ──
// `engine-steer.ts` records why this shape is needed: the rule used to live as a comment plus
// a list of corrected sites, "so a new bare-system steer could always be written again"
// (F-18). The same is true here. This walk fails the build when a rider is written with an
// intent the exclusion does not know, which is the only version of this fix that stays fixed.
describe('PHASE-2 T10H — the rider set is COMPLETE, enforced against the writers', () => {
  const src = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');

  /** Blank comments, keeping line count, so PROSE ABOUT a write is never counted as one.
   *  ⚠ THIS WAS NOT HERE FIRST, AND THE WALK CAUGHT IT ON ITS OWN AUTHOR: documenting the
   *  residue at the thrash-gate site put the words `convKey: 'engine-steer'` into a comment,
   *  and the scan reported a tenth "write site" with no `originIntent` near it. Same idiom as
   *  `work/__tests__/conv-key-inventory.test.ts` — a source scan that cannot tell a mechanism
   *  from a sentence about the mechanism is measuring the wrong thing (T10F/T10G's carried
   *  lesson, one turn further in). */
  const stripComments = (s: string): string => s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

  it('every steer site that used the conv_key sentinel writes a KNOWN rider intent', () => {
    const files = ['packages/server/src/agent/v2/loop.ts', 'packages/server/src/agent/a2a-transport.ts'];
    const found: string[] = [];
    for (const f of files) {
      const text = stripComments(src(f));
      // The sentinel write and its `originIntent:` sit inside one object literal; take the
      // nearest preceding intent for each sentinel occurrence.
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (!/convKey: 'engine-steer'/.test(line)) return;
        for (let j = i; j >= Math.max(0, i - 12); j--) {
          // ⚠ `[a-z_]+` was wrong here and the walk caught it: `a2a_handoff_floor` carries a
          // DIGIT, so the first version reported "no originIntent within 12 lines" for a site
          // that has one two lines above. My assertion, not the tree — corrected with the
          // reason in place rather than widened until it passed (T8a's precedent).
          const m = /originIntent: '([a-z0-9_]+)'/.exec(lines[j]);
          if (m) { found.push(m[1]); return; }
        }
        found.push(`<no originIntent within 12 lines of ${f}:${i + 1}>`);
      });
    }
    expect(found.length, 'the walk must find the steer sites, or it is vacuous').toBeGreaterThan(0);
    for (const intent of found) {
      expect(ENGINE_RIDER_INTENTS as readonly string[], `steer intent '${intent}' is not in ENGINE_RIDER_INTENTS`).toContain(intent);
    }
  });

  it('every postAgentNotice caller passes a KNOWN rider intent, and the default is one too', () => {
    const roots = ['packages/server/src'];
    const intents = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'migrations') walk(fp); continue; }
        if (!e.name.endsWith('.ts') || e.name.includes('.test.')) continue;
        const text = fs.readFileSync(fp, 'utf8');
        let idx = text.indexOf('postAgentNotice(');
        while (idx !== -1) {
          const window = text.slice(idx, idx + 600);
          const m = /intent: '([a-z0-9_]+)'/.exec(window);   // digits: see the steer walk above
          if (m) intents.add(m[1]);
          idx = text.indexOf('postAgentNotice(', idx + 1);
        }
      }
    };
    for (const r of roots) walk(path.join(REPO, r));
    expect(intents.size, 'the walk must find notice callers, or it is vacuous').toBeGreaterThan(0);
    for (const intent of intents) {
      expect(ENGINE_RIDER_INTENTS as readonly string[], `notice intent '${intent}' is not in ENGINE_RIDER_INTENTS`).toContain(intent);
    }
    // ...and the fallback the seam itself applies when a caller passes none.
    expect(src('packages/server/src/agent/agent-notice.ts')).toMatch(/opts\.intent \?\? 'agent_notice'/);
    expect(ENGINE_RIDER_INTENTS as readonly string[]).toContain('agent_notice');
  });

  it('the predicate reads the ONE set — there is no second list', () => {
    const cp = src('packages/server/src/agent/v2/counterparty.ts');
    expect(cp).toMatch(/ENGINE_RIDER_INTENTS_SQL/);
    // The old three-value literal is gone rather than left beside the constant, or the two
    // would drift and the older one would win somewhere.
    expect(cp).not.toMatch(/'thrash_gate', 'hint', 'system'/);
  });
});
