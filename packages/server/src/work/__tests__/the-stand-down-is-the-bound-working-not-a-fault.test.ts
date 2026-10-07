// ════════════════════════════════════════════════════════════════════════════════════════
// t131 — THE SANCTIONED STAND-DOWN IS NOT A FAULT, AND MUST NOT LOG LIKE ONE.
// (The 332 blast's last blocking finding. Extends t125's refusal clause, which is the
// clause that made this rung load-bearing in the first place.)
//
// ── THE FINDING ──────────────────────────────────────────────────────────────────────────
// The re-serve ladder's top rung logged at ERROR, on every occurrence:
//
//     error [ask-settlement] ask re-serve STOOD DOWN: the same question was served into
//                            silence up to its bound (sig 4367aae2)
//
// That rung is DESIGNED, UPHELD behaviour. It is the bound doing its job: the ask is not
// answered and not closed, it is held OWED and stays on the open-work surface, and there is
// nothing for an operator to fix. An `error` that fires every time a designed path is taken,
// and that nobody can act on, is the quieted-boot-divergence dishonesty class — it teaches
// every reader to skip the tier, and that is how a real error goes unseen. The words were
// the same problem: "STOOD DOWN … served into silence" reads as a damage report.
//
// ── WHY THIS CLAUSE IS AN EXTENSION OF t125'S, NOT A NEW SUBJECT ─────────────────────────
// t125 refused to `latchEngineCut` at the empty-response ladder's terminal rung, and the
// reason that survived review is precisely that a cut would bypass this stand-down and
// suppress its counter, so an unanswered ask could never settle to `blocked` — the one state
// where a question that was neither answered nor declined stays VISIBLE to its owner. That
// refusal rests on this rung being the sanctioned place an ask settles. A rung the platform
// relies on cannot also be the platform reporting its own failure.
//
// ── BOTH WAYS, which is the whole point of pinning a LEVEL ───────────────────────────────
//   (a) THE BOUND WORKING IS `warn`.      An `error` here reds this file.
//   (b) A GENUINE FAULT IS NEVER QUIETER.  `reServesSpent`'s unreadable counter is this
//       module's one real fault path, and it must stay at least as loud as (a) — an `info`
//       or a silent swallow reds. Checked by DRIVING the fault, not by reading the source.
//   (c) THE MODULE'S ERROR BUDGET IS ZERO, and that is a statement with a reason rather than
//       an accident: every failure mode in this file degrades safely and is reported at warn
//       or info. A future `logger.error` here must argue for itself against this census.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mockDb: { current: Database.Database | null } = { current: null };

/**
 * FAULT INJECTION, SURGICAL ON PURPOSE (clause (b)).
 *
 * The first version of that clause dropped `work_events` outright, and the drop broke
 * `qualifyingDelivery` too — which reads the same table — so the turn threw before the
 * ladder ever consulted its counter. A fault test that takes down a different query is not
 * driving the path it names. This fails EXACTLY the counter's own statement and nothing else.
 */
const failCounterRead = { on: false };
const COUNTER_SQL_MARK = 'COUNT(*) AS n FROM work_events';

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      const db = mockDb.current;
      if (!failCounterRead.on) return db;
      return new Proxy(db, {
        get(target, prop, recv) {
          if (prop !== 'prepare') return Reflect.get(target, prop, recv);
          return (sql: string) => {
            if (sql.includes(COUNTER_SQL_MARK)) throw new Error('database disk image is malformed');
            return target.prepare(sql);
          };
        },
      });
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-standdown-level-test', 'dojo.db'),
  };
});

const logged: Array<{ level: string; msg: string; meta: unknown }> = [];
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    error: (msg: string, meta?: unknown) => logged.push({ level: 'error', msg, meta }),
    warn: (msg: string, meta?: unknown) => logged.push({ level: 'warn', msg, meta }),
    info: (msg: string, meta?: unknown) => logged.push({ level: 'info', msg, meta }),
    debug: (msg: string, meta?: unknown) => logged.push({ level: 'debug', msg, meta }),
  }),
}));

import { runMigrations } from '../../db/migrations.js';
import { openAsk, claimAsk, appendWorkEvent } from '../store.js';
import { settleAsk, MAX_ASK_RE_SERVES, RE_SERVE_MARKER } from '../ask-settlement.js';

const AGENT = 'zargo';

/** An ask the agent has picked up, with `serves` hand-backs already spent on its own log. */
function seedAskWithSpentLadder(serves: number): string {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, lane, channel, conversation_id, created_at, seq)
     VALUES ('m-1', ?, 'user', 'why do you keep reassigning the email project?', 'owner', 'dashboard', 'conv-1', ?, NULL)`,
  ).run(AGENT, Date.now());
  const id = openAsk({
    agentId: AGENT, messageId: 'm-1', conversationId: 'conv-1', requesterId: 'owner',
    openedAt: Date.now(), title: 'why do you keep reassigning the email project?',
  });
  expect(claimAsk(id, AGENT).kind).toBe('applied');
  for (let i = 0; i < serves; i++) {
    appendWorkEvent(id, 'audit', 'ask-settlement', {
      marker: RE_SERVE_MARKER, attempt: i + 1, bound: MAX_ASK_RE_SERVES + 1,
      reason: 'the ask was handed back to be served again',
    });
  }
  return id;
}

/** The settlement moment the ladder runs at: a turn finalized having delivered nothing. */
const AT_FINALIZE = { agentId: AGENT, turnNumber: 7, at: 'finalize' as const };

beforeEach(() => {
  logged.length = 0;
  failCounterRead.on = false;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at)
     VALUES (?, 'Zargo', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES ('conv-1', ?, 'dashboard', 'owner')`,
  ).run(AGENT);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t131 — the stand-down is the bound working, not a fault', () => {
  it('(a) THE BOUND WORKING logs at WARN, never at error — and the ask really is held', () => {
    const id = seedAskWithSpentLadder(MAX_ASK_RE_SERVES);

    const out = settleAsk(id, AT_FINALIZE);

    // The rung was actually reached — otherwise this file would be asserting a level on a
    // path it never drove, which is the failure mode a log-level clause is most prone to.
    expect(out.verdict).toBe('held');
    expect(mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id))
      .toEqual({ state: 'blocked' });

    const standDown = logged.filter(l => /re-serve bound reached/.test(l.msg));
    expect(standDown).toHaveLength(1);
    // THE CLAUSE: designed behaviour is not an error.
    expect(standDown[0].level).toBe('warn');
    expect(logged.filter(l => l.level === 'error')).toEqual([]);
  });

  it('(a) the WORDS say the bound was honoured, not that something broke', () => {
    const id = seedAskWithSpentLadder(MAX_ASK_RE_SERVES);
    settleAsk(id, AT_FINALIZE);

    const msg = logged.find(l => /re-serve bound reached/.test(l.msg))!.msg;
    // It says what happened and what is true now: the ask is HELD and stops being re-served.
    expect(msg).toMatch(/HELD/);
    expect(msg).toMatch(/stop being re-served/);
    // It does not read as a damage report. These were the old words.
    expect(msg).not.toMatch(/STOOD DOWN/);
    expect(msg).not.toMatch(/served into silence/i);
    // And the operator-facing facts still ride the meta, unchanged.
    expect(logged.find(l => /re-serve bound reached/.test(l.msg))!.meta)
      .toMatchObject({ workId: id, serves: MAX_ASK_RE_SERVES + 1, bound: MAX_ASK_RE_SERVES + 1 });
  });

  it('CONTROL — an ask still inside its budget is handed back and never reaches the rung', () => {
    const id = seedAskWithSpentLadder(MAX_ASK_RE_SERVES - 1);

    expect(settleAsk(id, AT_FINALIZE).verdict).toBe('reopened');
    expect(logged.filter(l => /re-serve bound reached/.test(l.msg))).toEqual([]);
    expect(logged.filter(l => l.level === 'error')).toEqual([]);
  });

  it('CONTROL — the second arrival at an already-held ask says nothing twice', () => {
    const id = seedAskWithSpentLadder(MAX_ASK_RE_SERVES);
    settleAsk(id, AT_FINALIZE);
    logged.length = 0;

    expect(settleAsk(id, AT_FINALIZE).verdict).toBe('held');
    expect(logged.filter(l => /re-serve bound reached/.test(l.msg))).toEqual([]);
  });

  it('(b) A GENUINE FAULT IS NEVER QUIETER THAN THE BOUND WORKING — driven, not read', () => {
    // This module's one real fault path: the ladder cannot read its own counter. It degrades
    // SAFELY (it reports the ladder as spent, so the ask is held rather than re-served for
    // ever) — which is why it is a warn and not an error. What it must never be is quieter
    // than the designed rung above, because then a broken counter would hide behind a
    // perfectly ordinary-looking hold.
    const id = seedAskWithSpentLadder(MAX_ASK_RE_SERVES);
    failCounterRead.on = true;

    settleAsk(id, AT_FINALIZE);

    const fault = logged.filter(l => /could not read its own counter/.test(l.msg));
    expect(fault).toHaveLength(1);
    expect(['warn', 'error']).toContain(fault[0].level);
    expect(fault[0].meta).toMatchObject({ workId: id });
  });

  it('(c) THE MODULE’S ERROR BUDGET IS ZERO, and it is a statement with a reason', () => {
    // A census over the source, with its own denominator so it cannot pass vacuously: every
    // failure mode in this file degrades safely and is reported at warn or info. If a future
    // lane adds a `logger.error` here it must argue against this line — and if it adds one
    // for a genuine, operator-actionable fault, that is the moment to change this clause
    // deliberately rather than to discover it had silently stopped meaning anything.
    const src = readFileSync(
      fileURLToPath(new URL('../ask-settlement.ts', import.meta.url)), 'utf8',
    );
    const calls = src.match(/logger\.(error|warn|info|debug)\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(5);                       // the denominator
    expect(calls.filter(c => c === 'logger.error(')).toEqual([]);  // the budget
  });
});
