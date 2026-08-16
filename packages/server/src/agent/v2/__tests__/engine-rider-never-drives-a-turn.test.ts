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

  /** ⚠ PHASE-2 T10I REPLACED THIS CLAUSE'S ANCHOR, AND THE REASON IS THE POINT.
   *
   *  T10H's version found the steer sites by grepping for `convKey: 'engine-steer'` — the very
   *  sentinel write it had just proved was doing nothing. T10I deletes those writes (the column
   *  goes at `148`), so the anchor went with them, and a walk anchored on a deleted string is a
   *  walk that passes by finding zero sites. T10H already guarded against exactly that with
   *  `found.length > 0`, which is why this had to be REPLACED rather than allowed to lapse.
   *
   *  The replacement is STRICTLY STRONGER, and it is stronger because of what the old anchor
   *  could not see: it could only find sites that REMEMBERED to write the sentinel, which is
   *  the same weakness that let the hole open in the first place. This walk reads every
   *  events-lane WRITER in the tree — every `insertEngineEvent` / `insertEngineEventIfAbsent`
   *  call — and requires each one's `originIntent` to be classified, as either a rider or a
   *  declared DELIVERABLE. A new events-lane writer with an unclassified intent now fails the
   *  build whether or not its author knew this list existed. */
  const DECLARED_DELIVERABLE_INTENTS = [
    // Each of these IS the reason for a turn (engine-riders.ts's own first paragraph). Listed
    // here rather than exported, because this is the TEST's partition of the space: production
    // only needs to know what a rider is.
    'scheduler', 'tracker', 'reminder', 'a2a_request', 'completion_report', 'spawn_kickoff',
    'pm_review', 'pm_rename', 'validation_check', 'engine_event_expired', 'agent_health',
    'block_validated', 'schedule_run_failed', 'schedule_run_failed_owner', 'learning_loop',
    'healer',
    // STRIP (PHASE-3 T7 Step 2): 'cross_conv_send_echo' left with its writer. It was never
    // reachable by this walk in any case (the echo used insertMessageIfAbsent, not
    // insertEngineEvent*), so it was already a stale entry in this test's own partition.
  ] as const;

  it('EVERY events-lane writer in the tree carries a CLASSIFIED intent (rider or deliverable)', () => {
    const roots = ['packages/server/src'];
    const sites: Array<{ where: string; intent: string }> = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'migrations') walk(fp); continue; }
        if (!e.name.endsWith('.ts') || e.name.includes('.test.')) continue;
        // The writer module DECLARES these two functions; its own occurrences are the
        // definitions and the one forwarding to the other, not calls with an intent.
        if (path.relative(REPO, fp).endsWith('memory/message-store.ts')) continue;
        const text = stripComments(fs.readFileSync(fp, 'utf8'));
        for (const fn of ['insertEngineEventIfAbsent(', 'insertEngineEvent(']) {
          let idx = text.indexOf(fn);
          while (idx !== -1) {
            // The call's own object literal. 900 chars covers the longest of these calls
            // (measured: the widest is auto_scaffold's at ~360) without reaching the next one.
            const window = text.slice(idx, idx + 900);
            const m = /originIntent: '([a-z0-9_]+)'/.exec(window);
            const rel = path.relative(REPO, fp).split(path.sep).join('/');
            const line = text.slice(0, idx).split('\n').length;
            sites.push({ where: `${rel}:${line}`, intent: m ? m[1] : '<none>' });
            idx = text.indexOf(fn, idx + 1);
          }
        }
      }
    };
    for (const r of roots) walk(path.join(REPO, r));

    // Non-vacuity, both ways: the walk must find the writers, AND it must find the steer
    // sites that still write this lane — the ones the deleted anchor used to name.
    expect(sites.length, 'the walk must find events-lane writers, or it is vacuous').toBeGreaterThan(9);
    const STEER_INTENTS = ['thrash_block', 'delegation_hint',
      'owed_interrupt', 'fanout_join'];
    for (const intent of STEER_INTENTS) {
      expect(sites.map((s) => s.intent), `steer site '${intent}' is no longer written anywhere — either it moved (re-point this map) or a rider lost its writer`).toContain(intent);
    }

    // ── T53 (owner ruling 5): INTENTS WHOSE WRITER WAS RETIRED ON PURPOSE ──
    // A steer floor that stopped writing the events lane keeps its intent in
    // `ENGINE_RIDER_INTENTS` and loses it here, and the asymmetry is the point. The
    // exclusion list is read against ROWS, and every box already holds rows stamped with
    // these intents; dropping a value from a live exclusion ADMITS those rows as turn
    // drivers, which is the failure `engine-riders.ts` was written to end. So the value
    // stays excluded and only the "someone still writes it" clause is retired, per site.
    const WRITER_RETIRED_BY_T53 = ['thrash_drift', 'thrash_gate', 'auto_scaffold', 'promise_floor',
      'a2a_handoff_floor', 'reminder_silence_floor'];
    for (const intent of WRITER_RETIRED_BY_T53) {
      expect(ENGINE_RIDER_INTENTS as readonly string[], `'${intent}' must stay excluded: rows on disk still carry it`).toContain(intent);
      expect(sites.map((s) => s.intent), `'${intent}' is written again — a retired second channel came back`).not.toContain(intent);
    }

    // ONE site passes its intent as a VARIABLE (`opts.intent ?? 'agent_notice'`), and it is
    // named here rather than skipped by pattern: the clause below this one walks every
    // `postAgentNotice(` caller and checks the intent each one passes, plus the default. A
    // literal-only scan cannot see through a variable, so the coverage is split across two
    // clauses on purpose — and a NEW dynamic writer fails here until it is either given a
    // literal or added to this list with its own coverage argument.
    const DYNAMIC_INTENT_SITES_COVERED_BY_THE_POSTAGENTNOTICE_CLAUSE = [
      'packages/server/src/agent/agent-notice.ts',
    ];
    const classified = new Set<string>([...ENGINE_RIDER_INTENTS, ...DECLARED_DELIVERABLE_INTENTS]);
    for (const s of sites) {
      if (s.intent === '<none>'
          && DYNAMIC_INTENT_SITES_COVERED_BY_THE_POSTAGENTNOTICE_CLAUSE.some((f) => s.where.startsWith(f))) continue;
      expect(classified.has(s.intent), `${s.where} writes an events-lane row with intent '${s.intent}', which is neither a declared rider (agent/v2/engine-riders.ts) nor a declared deliverable (this test). Classify it: a rider must never drive a turn of its own; a deliverable must.`).toBe(true);
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
