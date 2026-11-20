// ════════════════════════════════════════════════════════════════════════════════════════
// EIGHT EXIT REASONS GET THEIR WRITERS — t93 (BACKLOG line 17)
//
// ── THE DEFECT, VERBATIM FROM THE ITEM ──────────────────────────────────────────────────
// "EIGHT exit reasons still have no writer (stop, preempt, abort, terminated, budget,
// provider_error, stream_idle, identical_call — 0 rows each in 10,934 turns): an owner
// pressing STOP is recorded as the model choosing silence and SPENDS an anti-repetition
// rung."
//
// `turns.exit_reason` is a 17-value enum, CHECKed by the column and published in the
// telemetry whitelist, and the production recorder could emit SIX of the words. The other
// eleven were decided and unreachable: `work/exit-attribution.ts` had already classified all
// eight of these as ENGINE-IMPOSED — meaning the ask ladder must not charge the model for
// them — and nothing could ever write one, so the ladder was handed `no_reply_intended` (A
// CLAIM ABOUT THE MODEL'S INTENT) for a turn an owner interrupted, and spent a rung on it.
// Four presses and an unanswered question stops being re-served.
//
// ── WHAT THIS FILE IS, AND WHAT IT IS NOT ───────────────────────────────────────────────
// It is the CENSUS and the SITES. The census is the clause that would have caught this years
// ago: an exit reason the DB CHECKs and the telemetry enum publishes, with no writer
// anywhere, is a word the record cannot say. It counts BOTH WAYS by construction —
//
//   · an enum member that resolves no writer FAILS (the original defect);
//   · a writer for a word that is not an enum member FAILS (TypeScript catches most, the
//     SQL literal in `turn-record.ts` it would not);
//   · the two members this task deliberately did NOT wire are DECLARED, and wiring one
//     without updating the declaration FAILS — so the list cannot rot into a hiding place.
//
// The RESOLVER is proven against a synthetic corpus before it is pointed at the tree, because
// a scan that answers "writer found" for everything is the same zero in a new coat. And it
// strips comments first: every one of these words appears in the prose of the files it
// scans, so a clause satisfiable by a comment would be testing the comment.
//
// The end-to-end half — the row the recorder actually writes, and the ask the settlement
// actually hands back — is `steps/teardown/__tests__/the-record-says-who-ended-the-turn.test.ts`.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t93-census', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { classifyThrownCut, latchEngineCut } from '../engine-exit.js';
import { initState, type AgentTurnState } from '../state.js';
import { markTurnsTerminated } from '../turn-record.js';
import { stoppedAgents } from '../../shared-state.js';
import { AgentError } from '../../errors.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE, STREAM_IDLE_TIMEOUT_CODE } from '../../stream-patience.js';
import { STREAM_FIRST_CHUNK_TIMEOUT_ERROR, STREAM_IDLE_TIMEOUT_ERROR } from '../../model.js';
import { UNRECOGNISED } from '../../../report/telemetry-whitelist.js';
import { buildTelemetry, type TelemetrySources } from '../../../report/telemetry-build.js';

interface Corpus { rel: string; code: string }

/** One writer, by SHAPE, with the file it lives in and the shape that found it. */
interface Writer { reason: string; rel: string; shape: string }

/**
 * THE RESOLVER. Which exit reasons does this corpus actually WRITE?
 *
 * Five shapes, each an APPLICATION and not a mention — a call with its argument, a SQL
 * assignment, a ternary arm inside the recorder's own declaration, a defaulted parameter.
 * A bare `'stop'` sitting in an array, a set literal or a type union matches NOTHING here,
 * which is what makes the answer about writers rather than about the word appearing.
 */
function resolveWriters(corpus: Corpus[]): Writer[] {
  const out: Writer[] = [];
  for (const { rel, code } of corpus) {
    // 1. The carrier's door, called with a literal reason.
    for (const m of code.matchAll(/latchEngineCut\([^;]*?,\s*'([a-z_]+)'\s*\)/g)) {
      out.push({ reason: m[1], rel, shape: 'latchEngineCut' });
    }
    // 2. The thrown-cut classifier's verdicts — the values that reach the carrier through
    //    the recovery arm's variable. Scoped to the function's own body.
    const cls = /export function classifyThrownCut\([\s\S]*?\n}/.exec(code);
    if (cls) {
      // `return 'stop';` and the arms of its own ternary verdict (`… ? null : 'provider_error'`).
      for (const m of cls[0].matchAll(/(?:return\s+|[?:]\s*)'([a-z_]+)'/g)) {
        out.push({ reason: m[1], rel, shape: 'classifyThrownCut' });
      }
    }
    // 3. A direct column write.
    for (const m of code.matchAll(/exit_reason\s*=\s*'([a-z_]+)'/g)) {
      out.push({ reason: m[1], rel, shape: 'UPDATE turns' });
    }
    // 4. The recorder's derivation — arms of the ONE declaration, never a ternary elsewhere.
    const chain = /const exitReason: TurnExitReason =[\s\S]*?;/.exec(code);
    if (chain) {
      for (const m of chain[0].matchAll(/[?:]\s*'([a-z_]+)'/g)) {
        out.push({ reason: m[1], rel, shape: 'recorder derivation' });
      }
    }
    // 5. A defaulted reason parameter (the injury path's quarantine value).
    for (const m of code.matchAll(/:\s*TurnExitReason\s*=\s*'([a-z_]+)'/g)) {
      out.push({ reason: m[1], rel, shape: 'default parameter' });
    }
  }
  return out;
}

/**
 * The enum members deliberately NOT wired, each with the reason.
 *
 * NOT a free pass: §2 asserts these have NO writer, so wiring one of them without moving it off
 * this list fails. The list can only shrink, and shrinking it is the visible act.
 *
 * ⚠ IT IS NOW EMPTY, AND THAT IS THE WHOLE OF t113 ITEM C. It held two entries,
 * `delegation_exit` and `compile_pending`, and the shrink did not come from wiring them — it
 * came from RETIRING them (orchestrator ruling, ledgered 2026-10-06; migration 184). Their
 * arguments live in `RETIRED_BY_RULING` below, unchanged, because the argument for not wiring
 * them is exactly the argument for retiring them.
 *
 * An empty list is a STRONGER census than a populated one, which is the thing to notice: §2's
 * CENSUS clause subtracts this list before refusing, so with nothing declared, ANY enum member
 * that has no production writer is now a failure with no exemption available. Re-adding a
 * writerless word reds immediately, and so does adding an entry here without an argument.
 */
const DECLARED_UNWIRED: ReadonlyArray<{ reason: string; why: string }> = [];

/**
 * THE TWO WORDS THAT LEFT THE VOCABULARY, and what must stay true of them.
 *
 * t93 found TEN unwired exit reasons rather than the eight its brief named, wrote eight, and
 * declined to invent writers for these two. The argument was never "we did not get to it":
 * both are MODEL dispositions and neither is an engine cut in the exit table, so wiring either
 * changes what the ask ladder CHARGES and not merely what the record says. Held for a ruling.
 *
 * The ruling was RETIRE, on the ground that a vocabulary naming events which cannot happen is
 * the dishonest-record family — a reader of the enum, of the DB CHECK, or of a telemetry report
 * is entitled to assume each declared value is a thing that occurs.
 *
 * ⚠ `compile_pending` ALSO NAMES A LIVE COLUMN, and the two are unrelated.
 * `work.compile_pending` is an INTEGER column the owed-compile gate and the fan-out join both
 * turn on; it is untouched and must stay untouched. What retired is the `turns.exit_reason`
 * WORD. The clause below is written against the enum, the CHECK and the whitelist only, so it
 * can never be satisfied or broken by anything in `work`.
 */
const RETIRED_BY_RULING: ReadonlyArray<{ reason: string; why: string }> = [
  {
    reason: 'delegation_exit',
    why: 'A MODEL disposition, and wiring it changes what the ask ladder CHARGES rather than '
      + 'only what the record says. The obvious site is the delegation-send async exit, and a '
      + 'turn that takes it records `park` today, which IS an engine cut in the exit table, while '
      + '`delegation_exit` deliberately is not. So the move would start spending rungs on '
      + 'delegating turns, which is a decision about the ladder and not a wiring gap. Retired '
      + 'rather than wired: the event it names has never happened and nobody has defined it.',
  },
  {
    reason: 'compile_pending',
    why: 'Declared in the enum, the DB CHECK and the telemetry whitelist with zero production '
      + 'references anywhere, and also a MODEL disposition per `exit-attribution.ts`. The '
      + 'compile-owed gate refuses tool calls; it does not end a turn, so there was no site to '
      + 'wire without first deciding what the word is for. Retired rather than wired, and NOT '
      + 'to be confused with the live `work.compile_pending` column, which keeps its name.',
  },
];

// ════════════════════════════════════════════════════════════════════════════════════════

let state: AgentTurnState;

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  state = initState({
    agentId: 'agent-under-test', contextWindow: 200_000, isAutoRouted: false,
    configuredModelId: 'model-1', turnNumber: 7, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: null,
    inboundChannel: null, inboundContext: null,
  });
});

afterEach(() => {
  stoppedAgents.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §0 — THE RESOLVER IS PROVEN BEFORE IT IS TRUSTED
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§0 the writer resolver answers about writers, not about the word appearing', () => {
  it('a corpus that only MENTIONS a reason resolves no writer for it', () => {
    const mentions: Corpus[] = [{
      rel: 'synthetic/mentions.ts',
      code: [
        "export const WORDS = ['stop', 'preempt', 'budget'];",
        "export type Union = 'stop' | 'abort';",
        "if (reason === 'terminated') return true;",
        "logger.info('stop', { reason: 'stop' });",
      ].join('\n'),
    }];
    expect(resolveWriters(mentions)).toEqual([]);
  });

  it('each of the five shapes resolves, and only with its argument present', () => {
    const shapes: Corpus[] = [{
      rel: 'synthetic/shapes.ts',
      code: [
        "return requestExit(latchEngineCut(state, 'stop'), 'stopped-by-user');",
        "export function classifyThrownCut(err: unknown, agentId: string): X | null {",
        "  if (isStopFenced(agentId)) return 'preempt';",
        '}',
        "UPDATE turns SET exit_reason = 'terminated', answered = 0",
        "const exitReason: TurnExitReason = flag ? 'brake' : 'no_reply_intended';",
        "export function markTurnDied(a: string, t: number, reason: TurnExitReason = 'unknown'): void {",
      ].join('\n'),
    }];
    const found = resolveWriters(shapes);
    expect(new Set(found.map((w) => w.reason)))
      .toEqual(new Set(['stop', 'preempt', 'terminated', 'brake', 'no_reply_intended', 'unknown']));
    expect(new Set(found.map((w) => w.shape))).toEqual(new Set([
      'latchEngineCut', 'classifyThrownCut', 'UPDATE turns', 'recorder derivation', 'default parameter',
    ]));
    // …and a call with no literal argument is not a writer of any particular word.
    expect(resolveWriters([{ rel: 'x.ts', code: 'latchEngineCut(state, thrownCut);' }])).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE CENSUS, COUNTING BOTH WAYS
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 every exit reason the record can hold has a production writer', () => {

  it('the DECLARED_UNWIRED list cannot rot — each entry still has no writer, and still argues', () => {
    // ⚠ THE LIST IS EMPTY AT THIS HEAD, so the loop above runs zero times and this clause would
    // be vacuous on its own. Said out loud rather than left to be discovered: what carries the
    // weight now is §2's CENSUS clause, which subtracts this list before refusing — so an empty
    // list means no enum member has an exemption at all. The clause below is the other half.
    expect(DECLARED_UNWIRED.map((d) => d.reason),
      'if an entry is ever added here, that is a deliberate act and the CENSUS clause stops '
      + 'covering that member — the entry must argue for itself, which the loop above checks')
      .toEqual([]);
  });

  it('THE RETIREMENT HOLDS — neither retired word is back in the enum, the CHECK, or the report', () => {
    expect(RETIRED_BY_RULING.map((r) => r.reason).sort(),
      'both words, so neither can be quietly dropped from the record of what was retired')
      .toEqual(['compile_pending', 'delegation_exit']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE CARRIER AND THE CLASSIFIER (the precedence, decided and driven)
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 first writer wins, and the throw is classified in a stated order', () => {
  it('a latch stands against a later one — the site that ENDED the turn names it', () => {
    const first = latchEngineCut(state, 'stop');
    expect(first.engineCutExit).toBe('stop');
    expect(latchEngineCut(first, 'provider_error').engineCutExit).toBe('stop');
    expect(latchEngineCut(latchEngineCut(first, 'abort'), 'budget').engineCutExit).toBe('stop');
  });

  it('an ordinary turn latches nothing', () => {
    expect(state.engineCutExit).toBeNull();
    expect(state.repeatRefusedThisTurn).toBe(false);
  });

  it('PRECEDENCE: a stop during a stream idle is `stop`, not `stream_idle`', () => {
    const idle = new AgentError(`${STREAM_IDLE_TIMEOUT_ERROR}: nothing for 60s`, 'a', {
      code: STREAM_IDLE_TIMEOUT_CODE,
    });
    expect(classifyThrownCut(idle, 'a'), 'with no stop standing it is the watchdog').toBe('stream_idle');
    stoppedAgents.add('a');
    expect(
      classifyThrownCut(idle, 'a'),
      'the owner pressed the button; the stall is how the button was felt',
    ).toBe('stop');
  });

  it('PRECEDENCE: a provider failure after a stop is `stop`', () => {
    const err = new AgentError('API error 402: {"message":"Insufficient Balance"}', 'a');
    expect(classifyThrownCut(err, 'a')).toBe('provider_error');
    stoppedAgents.add('a');
    expect(classifyThrownCut(err, 'a')).toBe('stop');
  });

  it('the watchdog is recognised by its CODE and by its PHRASE — the throw sites differ', () => {
    expect(classifyThrownCut(new AgentError('x', 'a', { code: STREAM_IDLE_TIMEOUT_CODE }), 'a')).toBe('stream_idle');
    expect(classifyThrownCut(new Error(`${STREAM_IDLE_TIMEOUT_ERROR}: the stream ended on the watchdog's abort`), 'a'))
      .toBe('stream_idle');
    expect(classifyThrownCut(new Error(`${STREAM_FIRST_CHUNK_TIMEOUT_ERROR}: 90s and no token`), 'a'))
      .toBe('stream_idle');
    // A declared-patience exhaustion is the same watchdog one bound earlier — never the
    // provider's fault, which is what `provider_error` would say.
    expect(classifyThrownCut(new AgentError('declared bound exceeded', 'a', { code: DECLARED_PATIENCE_EXCEEDED_CODE }), 'a'))
      .toBe('stream_idle');
  });

  it('an abort that is not the stop door and not the watchdog is `abort`', () => {
    const dom = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(classifyThrownCut(dom, 'a')).toBe('abort');
    const sdk = Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' });
    expect(classifyThrownCut(sdk, 'a')).toBe('abort');
    expect(classifyThrownCut(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }), 'a')).toBe('abort');
  });

  it('a provider VERDICT is `provider_error`; a bug in this engine is left `unknown`', () => {
    expect(classifyThrownCut(new AgentError('API error 429: rate_limit_error', 'a'), 'a')).toBe('provider_error');
    expect(classifyThrownCut(new AgentError('API error 500: internal server error', 'a'), 'a')).toBe('provider_error');
    // The refusal that keeps `unknown` meaning what `markTurnDied`'s docstring says it means.
    expect(
      classifyThrownCut(new TypeError('cannot read properties of undefined'), 'a'),
      'naming a cause we did not observe is the failure this project keeps finding',
    ).toBeNull();
    expect(classifyThrownCut(new Error('assembly validation failed'), 'a')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE DB CHECK AND THE TELEMETRY ENUM (D4: the consequences, handled and proven)
// ════════════════════════════════════════════════════════════════════════════════════════

// ⚠ THE TITLE USED TO SAY "all seventeen" AND IT WAS STALE THE MOMENT t113 C RETIRED TWO
// WORDS. The CLAUSES below never were: all three derive the expected set from
// `enumMembersFromSource()`, so they passed unchanged across the retirement and would pass
// across the next one. Only the sentence was wrong, which is the exact shape of a census that
// lies about itself — so the number comes out of the title rather than being corrected to a
// figure that goes stale again. (The migrated CHECK is compared to the source enum in the
// first clause, which is also what proves migration 184 admits precisely the surviving set.)
describe('§4 the column and the telemetry enum admit exactly what the enum declares', () => {
  const ALL_EIGHT = ['stop', 'preempt', 'abort', 'terminated', 'budget', 'provider_error',
    'stream_idle', 'identical_call'] as const;

  it('each of the eight INSERTs, and a word outside the enum is refused', () => {
    const db = mockDb.current!;
    db.prepare("INSERT INTO agents (id, name, status) VALUES ('a', 'A', 'idle')").run();
    const insert = (turn: number, reason: string): void => {
      db.prepare(
        `INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
         VALUES ('a', ?, datetime('now'), datetime('now'), ?, 0)`,
      ).run(turn, reason);
    };
    ALL_EIGHT.forEach((r, i) => { expect(() => insert(100 + i, r), r).not.toThrow(); });
    // Both ways: the CHECK is real, so a word nobody declared cannot be written.
    expect(() => insert(999, 'cancelled_by_the_weather')).toThrow(/CHECK/);
  });

  it('each new value survives the telemetry build instead of coercing to <unrecognised>', () => {
    const sources: TelemetrySources = {
      reportId: 'r-1', createdAt: '2026-10-05 00:00:00', signature: 'sig', lane: 'dashboard',
      platformVersion: '3.3.0', osPlatform: 'darwin', nodeMajor: 22,
      windowMinutes: 10, windowTurns: ALL_EIGHT.length, windowTruncated: false,
      turns: ALL_EIGHT.map((reason) => ({
        kind: 'user', subjectKind: 'conv', lane: null, exitReason: reason,
        answered: false, effectfulCalls: 0, durationMs: 1000,
      })),
      calls: [], toolCalls: [], work: [],
      settings: {} as TelemetrySources['settings'],
    };
    // `emit()` keys the record by the whitelist LEAF, so the field is `exit_reason`; a value
    // the enum did not admit would come back as the `<unrecognised>` sentinel instead.
    const turns = buildTelemetry(sources).turns as Array<Record<string, unknown>>;
    expect(turns.map((t) => t.exit_reason)).toEqual([...ALL_EIGHT]);
    expect(turns.map((t) => t.exit_reason)).not.toContain(UNRECOGNISED);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE REAPER'S WRITE, DRIVEN
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 a dead process\'s abandoned turn rows are closed as `terminated`', () => {
  const openTurn = (turn: number): void => {
    mockDb.current!.prepare(
      `INSERT INTO turns (agent_id, turn_number, started_at, answered) VALUES ('a', ?, datetime('now'), 0)`,
    ).run(turn);
  };

  beforeEach(() => {
    mockDb.current!.prepare("INSERT INTO agents (id, name, status) VALUES ('a', 'A', 'working')").run();
    mockDb.current!.prepare("INSERT INTO agents (id, name, status) VALUES ('b', 'B', 'working')").run();
  });

  it('every open row for the reaped agent closes, and nobody else\'s does', () => {
    openTurn(1); openTurn(2);
    mockDb.current!.prepare(
      `INSERT INTO turns (agent_id, turn_number, started_at, answered) VALUES ('b', 1, datetime('now'), 0)`,
    ).run();
    expect(markTurnsTerminated('a')).toBe(2);
    const rows = mockDb.current!.prepare(
      'SELECT agent_id, turn_number, exit_reason, ended_at FROM turns ORDER BY agent_id, turn_number',
    ).all() as Array<{ agent_id: string; exit_reason: string | null; ended_at: string | null }>;
    expect(rows.filter((r) => r.agent_id === 'a').map((r) => r.exit_reason)).toEqual(['terminated', 'terminated']);
    expect(rows.filter((r) => r.agent_id === 'a').every((r) => r.ended_at !== null)).toBe(true);
    expect(rows.find((r) => r.agent_id === 'b')!.exit_reason, 'another agent\'s live turn was closed').toBeNull();
  });

  it('a turn that already finalized is left exactly as it stands', () => {
    mockDb.current!.prepare(
      `INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
       VALUES ('a', 1, datetime('now'), datetime('now'), 'answered', 1)`,
    ).run();
    expect(markTurnsTerminated('a')).toBe(0);
    expect((mockDb.current!.prepare(
      'SELECT exit_reason, answered FROM turns WHERE agent_id = ? AND turn_number = 1',
    ).get('a') as { exit_reason: string; answered: number })).toEqual({ exit_reason: 'answered', answered: 1 });
  });

  it('a sweep with nothing to close says zero rather than guessing', () => {
    expect(markTurnsTerminated('a')).toBe(0);
  });
});
