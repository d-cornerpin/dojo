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
import fs from 'node:fs';
import path from 'node:path';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t93-census', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { SERVER_SRC, engineSources, engineText } from './engine-sources.js';
import { classifyThrownCut, latchEngineCut } from '../engine-exit.js';
import { initState, type AgentTurnState } from '../state.js';
import { markTurnsTerminated, type TurnExitReason } from '../turn-record.js';
import { stoppedAgents } from '../../shared-state.js';
import { AgentError } from '../../errors.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE, STREAM_IDLE_TIMEOUT_CODE } from '../../stream-patience.js';
import { STREAM_FIRST_CHUNK_TIMEOUT_ERROR, STREAM_IDLE_TIMEOUT_ERROR } from '../../model.js';
import { ENGINE_IMPOSED_EXITS } from '../../../work/exit-attribution.js';
import { TELEMETRY_WHITELIST, UNRECOGNISED } from '../../../report/telemetry-whitelist.js';
import { buildTelemetry, type TelemetrySources } from '../../../report/telemetry-build.js';

// ════════════════════════════════════════════════════════════════════════════════════════
// THE CORPUS AND THE RESOLVER
// ════════════════════════════════════════════════════════════════════════════════════════

/** Comments blanked, length-preserving. Every word below appears in prose in these files. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

const read = (rel: string): string => fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8');

/**
 * The engine's own collaborators this subject lives in, named rather than walked.
 *
 * `engine-sources.ts`'s header makes the rule: the shared derivation is the driver plus the
 * step packages, and "a guard that wants one of those reads it by name". Three of the four
 * writers outside the step packages are deliberate design choices argued at their sites —
 * the carrier, the table's one write module, and the reaper — so naming them is the narrower
 * and therefore stronger corpus.
 */
const COLLABORATORS = [
  'agent/v2/engine-exit.ts',
  'agent/v2/turn-record.ts',
  'agent/v2/recovery.ts',
  'agent/runtime.ts',
] as const;

interface Corpus { rel: string; code: string }

function productionCorpus(): Corpus[] {
  return [
    ...engineSources().map((s) => ({ rel: s.rel, code: stripComments(s.text) })),
    ...COLLABORATORS.map((rel) => ({ rel, code: stripComments(read(rel)) })),
  ];
}

/**
 * Every exit reason the enum declares, read off the SOURCE rather than listed here.
 *
 * A list in the test is a second copy of the vocabulary and would simply agree with itself
 * when a member is added. This reads `turn-record.ts`'s union, which is the declaration the
 * DB CHECK and the telemetry whitelist are both derived from.
 */
function enumMembersFromSource(): string[] {
  const src = read('agent/v2/turn-record.ts');
  const m = /export type TurnExitReason =([\s\S]*?);/.exec(src);
  if (!m) throw new Error('turn-record.ts no longer declares `export type TurnExitReason` — this census has lost its subject.');
  const words = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  if (words.length < 10) throw new Error(`the TurnExitReason union parsed to ${words.length} members — the derivation broke.`);
  return words;
}

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
 * The enum members this task deliberately did NOT wire, each with the reason.
 *
 * NOT a free pass: §2 asserts these have NO writer, so wiring one of them without moving it
 * off this list fails. The list can only shrink, and shrinking it is the visible act.
 */
const DECLARED_UNWIRED: ReadonlyArray<{ reason: string; why: string }> = [
  {
    reason: 'delegation_exit',
    why: 'A MODEL disposition, and wiring it changes what the ask ladder CHARGES rather than '
      + 'only what the record says. The obvious site is the delegation-send async exit, and a '
      + 'turn that takes it records `park` today — which IS in ENGINE_IMPOSED_EXITS, while '
      + '`delegation_exit` deliberately is not. So the move would start spending rungs on '
      + 'delegating turns, which is a decision about the ladder and not a wiring gap.',
  },
  {
    reason: 'compile_pending',
    why: 'Declared in the enum, the DB CHECK and the telemetry whitelist with zero production '
      + 'references anywhere, and also a MODEL disposition per `exit-attribution.ts`. The '
      + 'compile-owed gate refuses tool calls; it does not end a turn, so there is no site to '
      + 'wire without first deciding what the word is for.',
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
    inboundChannel: null, inboundContext: null, pendingTechniqueAck: null,
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

  it('the real corpus is not vacuous — it is the driver, the step packages and the four named files', () => {
    const corpus = productionCorpus();
    expect(corpus.length, 'the corpus collapsed').toBeGreaterThan(40);
    for (const rel of COLLABORATORS) {
      expect(corpus.map((c) => c.rel), `${rel} fell out of the corpus`).toContain(rel);
    }
    // The strip is real: the words are everywhere in the prose and nowhere in a comment here.
    expect(engineText()).toContain('an owner pressing STOP');
    expect(productionCorpus().map((c) => c.code).join('\n')).not.toContain('an owner pressing STOP');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE CENSUS, COUNTING BOTH WAYS
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 every exit reason the record can hold has a production writer', () => {
  const writers = (): Map<string, Writer[]> => {
    const by = new Map<string, Writer[]>();
    for (const w of resolveWriters(productionCorpus())) {
      const list = by.get(w.reason) ?? [];
      list.push(w);
      by.set(w.reason, list);
    }
    return by;
  };

  it('CENSUS — no enum member is left with nothing that can write it', () => {
    const by = writers();
    const declared = new Set(DECLARED_UNWIRED.map((d) => d.reason));
    const orphans = enumMembersFromSource().filter((w) => !by.has(w) && !declared.has(w));
    expect(
      orphans,
      'these exit reasons are declared in `TurnExitReason`, CHECKed by the column and published '
      + 'in the telemetry enum, and NOTHING in production can write one. That is BACKLOG line '
      + "17's defect exactly: the record cannot say what happened, so the ask ladder is handed "
      + 'the model\'s intent for a turn the engine ended. Wire it, or add a DECLARED_UNWIRED '
      + 'entry saying what has to be decided first.',
    ).toEqual([]);
  });

  it('the eight the item named each resolve a writer, and the shape says which site', () => {
    const by = writers();
    for (const reason of ['stop', 'preempt', 'abort', 'terminated', 'budget', 'provider_error',
      'stream_idle', 'identical_call']) {
      expect(by.get(reason), `${reason} has no production writer`).toBeTruthy();
      expect(by.get(reason)!.length, reason).toBeGreaterThan(0);
    }
    // And they arrive by the routes the design says, not by accident.
    expect(by.get('stop')!.map((w) => w.shape)).toContain('latchEngineCut');
    expect(by.get('stop')!.map((w) => w.shape)).toContain('classifyThrownCut');
    expect(by.get('terminated')!.map((w) => w.shape)).toContain('UPDATE turns');
    expect(by.get('terminated')!.map((w) => w.rel)).toContain('agent/v2/turn-record.ts');
    expect(by.get('identical_call')!.map((w) => w.shape)).toContain('recorder derivation');
  });

  it('COUNTING THE OTHER WAY — nothing writes a word the enum does not declare', () => {
    const members = new Set(enumMembersFromSource());
    const strays = [...new Set(resolveWriters(productionCorpus())
      .filter((w) => !members.has(w.reason))
      .map((w) => `${w.reason} (${w.shape} in ${w.rel})`))];
    expect(
      strays,
      'something writes an exit reason the enum does not declare. TypeScript catches the typed '
      + 'routes; it cannot see the SQL literal in `turn-record.ts`, and the DB CHECK would throw '
      + 'at the one moment the write mattered.',
    ).toEqual([]);
  });

  it('the DECLARED_UNWIRED list cannot rot — each entry still has no writer, and still argues', () => {
    const by = writers();
    const members = new Set(enumMembersFromSource());
    for (const d of DECLARED_UNWIRED) {
      expect(members, `${d.reason} is declared unwired but is not in the enum at all`).toContain(d.reason);
      expect(
        by.get(d.reason),
        `${d.reason} now HAS a writer — move it off DECLARED_UNWIRED, and say so where the `
        + 'ladder\'s classification is decided (`work/exit-attribution.ts`).',
      ).toBeUndefined();
      expect(d.why.trim().length, `${d.reason}'s reason is too thin to be an argument`).toBeGreaterThan(120);
    }
  });

  it('every engine-imposed word is writable, which is what makes the classification reachable', () => {
    const by = writers();
    const unreachable = [...ENGINE_IMPOSED_EXITS].filter((w) => !by.has(w));
    expect(
      unreachable,
      '`ENGINE_IMPOSED_EXITS` promises the ask ladder will not charge the model for these. A '
      + 'member nothing can write is a promise about a state the record cannot reach — which is '
      + 'how eight of them sat classified and unreachable for 10,934 turns.',
    ).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE SITES, AND THE CARRIER'S APPLICATION
//
// A writer that latches a fact nobody reads is the same zero. These clauses pin the two ends:
// each latch site, and the recorder actually consulting the carrier.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the sites that end a turn carry their reason, and the recorder reads it', () => {
  const engine = (): string => stripComments(engineText());

  it('the stop door latches at every checkpoint that can see a live stop', () => {
    const code = engine();
    // The pre-call gate, the model call's abandon, the executor's mid-batch break, and the
    // turn-budget checkpoint's re-read. Four sites, one word.
    const stopLatches = [...code.matchAll(/latchEngineCut\([^;]*?,\s*'stop'\s*\)/g)];
    expect(stopLatches.length, 'a stop checkpoint stopped recording the stop').toBeGreaterThanOrEqual(4);
    expect(code).toMatch(/isStopFenced\(agentId\)[\s\S]{0,400}latchEngineCut\([^;]*'stop'\)/);
  });

  it('the preempt arms latch `preempt` — the gate and the mid-call abandon', () => {
    const code = engine();
    expect([...code.matchAll(/latchEngineCut\([^;]*?,\s*'preempt'\s*\)/g)].length).toBeGreaterThanOrEqual(2);
    expect(code).toMatch(/preemptedAgents\.has\(agentId\)[\s\S]{0,400}latchEngineCut\([^;]*'preempt'\)/);
  });

  it('both turn-budget arms latch `budget` — the cap trip and the checkpoint continuation', () => {
    const code = engine();
    expect([...code.matchAll(/latchEngineCut\([^;]*?,\s*'budget'\s*\)/g)].length).toBeGreaterThanOrEqual(2);
    expect(code).toMatch(/turn-continuation-cap/);
  });

  it('the reaper closes the rows a dead process abandoned, and the write stays in one module', () => {
    const runtime = stripComments(read('agent/runtime.ts'));
    expect(runtime, 'the reaper no longer closes the abandoned turn rows').toMatch(/markTurnsTerminated\(agent\.id\)/);
    // One module owns `UPDATE turns`, which is why the reaper calls instead of writing.
    expect(runtime).not.toMatch(/UPDATE\s+turns/);
    expect(stripComments(read('agent/v2/turn-record.ts'))).toMatch(/exit_reason = 'terminated'/);
  });

  it('the recovery arm classifies the throw and latches what it found, before the cascade runs', () => {
    const code = engine();
    // The order is load-bearing: `recordInjury` closes the row itself, so a latch applied after
    // the cascade would be written to a state the row had stopped listening to.
    expect(code, 'the thrown turn stopped being classified')
      .toMatch(/classifyThrownCut\(err, agentId\)[\s\S]{0,200}latchEngineCut\(state, thrownCut\)/);
    expect(code, 'the cascade is handed the un-latched state, so the injury path cannot see the cause')
      .toMatch(/recoverFromError\(turnState, err/);
  });

  it('the executor carries the brake ledger\'s refusal count onto the state the recorder reads', () => {
    const code = engine();
    expect(code, 'the identical-call rung stopped being read off the brake\'s own ledger')
      .toMatch(/identicalCallRefusedThisTurn:[\s\S]{0,160}anyIdenticalCallRefused\(identicalCallState\)/);
  });

  it('the recorder READS the carrier, and the injury path reads it too', () => {
    const chain = engine();
    expect(chain, 'the derivation stopped consulting the engine cut')
      .toMatch(/const exitReason: TurnExitReason =[\s\S]{0,200}state\.engineCutExit \? state\.engineCutExit/);
    expect(chain, 'the identical-call rung stopped reaching the derivation')
      .toMatch(/state\.identicalCallRefusedThisTurn \? 'identical_call'/);
    // The injury path closes the row FIRST (`AND ended_at IS NULL`), so it must carry the
    // same fact or the recorder's word never lands on a thrown turn.
    expect(stripComments(read('agent/v2/recovery.ts')))
      .toMatch(/markTurnDied\(agentId, state\.turnNumber, state\.engineCutExit \?\? 'unknown'\)/);
  });

  it('the brake keeps its precedence, and the cut is tested before the answer', () => {
    const home = engineSources().find((s) => s.text.includes('const exitReason: TurnExitReason ='));
    expect(home, 'the recorder derivation left the engine corpus').toBeTruthy();
    const src = home!.text;
    const chain = src.slice(src.indexOf('const exitReason: TurnExitReason ='));
    const at = (needle: string): number => {
      const i = chain.indexOf(needle);
      expect(i, `${needle} is not in the derivation`).toBeGreaterThan(-1);
      return i;
    };
    // d54cd1f's order, untouched: the brake outranks everything, including the cut.
    expect(at('toolPhaseEndedBySpinBrake')).toBeLessThan(at('state.engineCutExit'));
    // …and the cut outranks the answer, because `turns.answered` records the reply separately.
    expect(at('state.engineCutExit')).toBeLessThan(at('answerRow ?'));
    // …and the identical-call rung is the LAST word before the fallback, never above the cap.
    expect(at('toolLoopCapReached')).toBeLessThan(at("'identical_call'"));
    expect(at("'identical_call'")).toBeLessThan(at("'no_reply_intended'"));
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
    expect(state.identicalCallRefusedThisTurn).toBe(false);
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

describe('§4 the column and the telemetry enum already admit all seventeen', () => {
  const ALL_EIGHT = ['stop', 'preempt', 'abort', 'terminated', 'budget', 'provider_error',
    'stream_idle', 'identical_call'] as const;

  it('the CHECK on `turns.exit_reason` is read off the MIGRATED schema and lists every member', () => {
    const sql = (mockDb.current!.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turns'",
    ).get() as { sql: string }).sql;
    const m = /exit_reason IN \(([\s\S]*?)\)/.exec(sql);
    expect(m, 'the CHECK constraint is gone from the column').toBeTruthy();
    const admitted = new Set([...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    expect([...admitted].sort()).toEqual(enumMembersFromSource().sort());
  });

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

  it('the telemetry whitelist publishes exactly the source enum — no migration, no drift', () => {
    const field = TELEMETRY_WHITELIST.find((f) => f.path === 'turn.exit_reason');
    expect(field, '`turn.exit_reason` left the whitelist').toBeTruthy();
    expect([...(field!.members ?? [])].sort()).toEqual(enumMembersFromSource().sort());
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
