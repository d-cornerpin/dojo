// SWEEP-A TB1 Step 4 — THE TWO CENSUSES THAT KEEP THE AUTHORITY THE ONLY AUTHORITY.
//
// DESIGN-2BUGS §1: "a permanent test enumerates every code site that can write ask state
// `done` and asserts they all resolve to the one authority; a second census asserts the
// structural invariant (no `claimed` ask whose claiming turn has finalized)."
//
// WHAT THEY MEASURED AT THE PRE-CHANGE TREE (`3439240`), so RED is a number:
//   PART A — `work/store.ts` carried FIVE `to: 'done'` sites and `work/ask-settlement.ts`
//            did not exist; the ask-reaching ones were `closeAsksForDelivery`,
//            `reconcileOrphanedClaims`, `settleJoinDelivered` and `resolveCommitment`
//            (the model's own tool) — FOUR owners of one decision (verify report M2).
//   PART B — a turn could finalize leaving its ask `claimed` for ever: the recorded fossil,
//            reproduced 4/4 by the kit scenario `ask-burst-always-settles` at TB0.
//
// Neither census can pass vacuously: PART A asserts the measured map EQUALS the declared
// inventory in BOTH directions (a new `done` writer fails; a stale entry fails too) and
// carries planted-fault self-tests for its scanner; PART B drives real rows.

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-ask-done-census', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { askIdForMessage, claimAsk, stampClaimingTurn, openDelegationJoin } from '../store.js';
import { settleAsksAtTurnFinalize } from '../ask-settlement.js';
import { insertMessage } from '../../memory/message-store.js';
// The engine corpus comes from the ONE shared derivation (PHASE-6 GUARD-AUDIT): a guard that
// hand-rolls its own walk of `agent/v2/steps` is how six copies drifted apart before.
import { engineFileContaining, engineText } from '../../agent/v2/__tests__/engine-sources.js';

// ════════════════════════════════════════════════════════════════════════════════
// PART A — EVERY WRITER OF ASK-`done` RESOLVES TO THE AUTHORITY
// ════════════════════════════════════════════════════════════════════════════════

const SRC = path.join(__dirname, '..', '..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations') continue;
      walk(fp, acc);
    } else if (e.name.endsWith('.ts')) acc.push(fp);
  }
  return acc;
}

const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

export interface DoneSites { done: number; dynamic: number }

/**
 * Two counts per file, and BOTH are load-bearing:
 *   `done`    — a transition input carrying the literal `to: 'done'`;
 *   `dynamic` — a `transition(...)` whose target state is a variable, so the literal count
 *               cannot see it. `setTrackerStatus` is written that way (property shorthand
 *               `to,`), and a census that only counted literals would have a hole exactly
 *               the shape of the next closer somebody adds.
 */
export function measureDoneSites(text: string): DoneSites {
  const t = stripComments(text);
  const done = (t.match(/\bto:\s*'done'/g) ?? []).length;
  let dynamic = 0;
  const call = /\btransition\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(t))) {
    const seg = t.slice(m.index, m.index + 500);
    const target = seg.match(/\bto\s*(?::\s*([^,\n]+)|,)/);
    if (!target) continue;
    const value = (target[1] ?? '').trim();
    if (value === '' || !/^['"]/.test(value)) dynamic++;
  }
  return { done, dynamic };
}

/**
 * THE DECLARED INVENTORY. Every site in the tree that can move a `work` row to `done`, with
 * the subject it can reach. Exact equality in both directions is what makes it a measurement
 * rather than a list somebody maintains by hope.
 */
const DONE_WRITERS: Record<string, DoneSites & { subjects: string; owner: string }> = {
  // THE AUTHORITY. One predicate, three invocations (delivery / turn finalize / boot).
  'work/ask-settlement.ts': {
    // SWEEP-A TB2 folded the join arm IN, so this file now carries two `done` sites: the
    // authority's delivery/finalize/boot close and its join close. Both are the same
    // predicate in the same function — `settleOnJoin` is an arm of `settleAsk`, reached only
    // through it — which is exactly what "one authority" was supposed to mean.
    done: 2, dynamic: 0, subjects: 'ask',
    owner: 'settleAsk — the ONE settlement authority for owner asks (SWEEP-A TB1), including '
      + 'its join arm (SWEEP-A TB2: children settled + the compiled delivery, `compile_resolved` written)',
  },
  'work/store.ts': {
    // TB2 TIGHTENING: 3 -> 2. `settleJoinDelivered` is GONE from this file; it took the last
    // ask-reaching `done` outside the authority with it.
    done: 2, dynamic: 1, subjects: 'join pieces (kind=task/root a2a_thread), commitments',
    owner: 'landPiece (piece, literal + dynamic re-settle), resolveCommitment '
      + '(commitments ONLY: it refuses an ask row)',
  },
  'work/occurrences.ts': {
    done: 1, dynamic: 0, subjects: 'occurrence',
    owner: 'settleOccurrenceRun — a scheduler run closing on its own record',
  },
  'work/tracker-store.ts': {
    done: 0, dynamic: 1, subjects: 'task, project',
    owner: 'setTrackerStatus — the tracker two nouns, two-key gated by G9',
  },
};

/** The sites that can reach a `kind='ask'` row. This is the number the design exists to
 *  reduce: FOUR at `3439240` (verify report M2), TWO at TB1's close (the authority plus the
 *  join relay, handed forward), and **ONE** since SWEEP-A TB2 folded the join arm in. The
 *  inventory is a TIGHTENING each time it shrinks, and the equality below is what refuses a
 *  new one appearing quietly. */
const ASK_DONE_WRITERS: Array<{ file: string; fn: string; handedTo?: string }> = [
  { file: 'work/ask-settlement.ts', fn: 'settleAsk' },
];

describe('CENSUS A — every writer of ask-`done` resolves to the one authority', () => {
  const files = (): string[] => walk(SRC).map(rel).sort();
  const read = (r: string): string => fs.readFileSync(path.join(SRC, r), 'utf8');

  it('the measured map of `done` writers EQUALS the declared inventory, both directions', () => {
    const measured: Record<string, DoneSites> = {};
    for (const f of files()) {
      const s = measureDoneSites(read(f));
      if (s.done > 0 || s.dynamic > 0) measured[f] = s;
    }
    const declared: Record<string, DoneSites> = {};
    for (const [f, v] of Object.entries(DONE_WRITERS)) declared[f] = { done: v.done, dynamic: v.dynamic };
    expect(measured).toEqual(declared);
  });

  it('the ask-reaching writers are the authority and the join arm, and nothing else', () => {
    expect(ASK_DONE_WRITERS.map((w) => `${w.file}:${w.fn}`)).toEqual([
      'work/ask-settlement.ts:settleAsk',
    ]);
    // …and every ask-reaching site that is NOT the authority carries the task that folds it in.
    for (const w of ASK_DONE_WRITERS) {
      if (w.file === 'work/ask-settlement.ts') continue;
      expect(w.handedTo, `${w.fn} must name the task that folds it into the authority`).toBeTruthy();
    }
    for (const w of ASK_DONE_WRITERS) {
      expect(read(w.file), `${w.fn} must exist where the census says it does`)
        .toMatch(new RegExp(`export function ${w.fn}\\b`));
    }
  });

  it('THE DEMOLITION IS REAL: the FOUR retired ask closers are gone from the tree', () => {
    // Each of these decided "is this ask settled?" on its own evidence at its own moment.
    // Their requirements live on inside the authority; their code does not live on anywhere.
    const all = files().map(read).join('\n');
    expect(all, 'closeAsksForDelivery decided at send time — it is now the authority delivery arm')
      .not.toMatch(/export function closeAsksForDelivery/);
    expect(all, 'claimAssembledSiblings wrote state at teardown — it is now a read that feeds finalize')
      .not.toMatch(/export function claimAssembledSiblings/);
    expect(read('work/store.ts'), 'the boot reconciler moved to the authority module')
      .not.toMatch(/export function reconcileOrphanedClaims/);
    // SWEEP-A TB2 — the fourth. It decided the join's close on whatever delivery id the relay
    // handed it, so the delegating turn's own status line was an acceptable receipt.
    expect(read('work/store.ts'), 'the join relay close is the authority join arm now')
      .not.toMatch(/export function settleJoinDelivered/);
    expect(all, 'nothing outside the authority may settle a join')
      .not.toMatch(/export function settleJoinDelivered/);
  });

  it('the authority is REACHED from all three of its declared moments', () => {
    expect(read('agent/v2/deliveries.ts'), 'invocation (a): inside the delivery transaction')
      .toMatch(/settleAsksForDelivery\(/);
    expect(engineText(), 'invocation (b): the turn-finalize adjudicator')
      .toMatch(/settleAsksAtTurnFinalize\(/);
    expect(read('index.ts'), 'invocation (c): boot reconcile').toMatch(/reconcileOrphanedClaims\(/);
  });

  it('the model own close tool no longer decides an ask, and says so steerably', () => {
    const tool = stripComments(read('agent/tools/cat/tracker.ts'));
    expect(tool, "the ask branch must refuse rather than close").toMatch(/kind === 'ask'/);
    expect(tool, 'the refusal must point at the record that does decide')
      .toMatch(/delivered|receipt|record/i);
  });

  it('SELF-TEST: the scanner sees both forms and is not fooled by prose', () => {
    expect(measureDoneSites("transition(id, { to: 'done', by: 'agent' })")).toEqual({ done: 1, dynamic: 0 });
    expect(measureDoneSites('transition(id, {\n  to,\n  by: input.by,\n})')).toEqual({ done: 0, dynamic: 1 });
    expect(measureDoneSites('transition(id, { to: nextState, by: "agent" })')).toEqual({ done: 0, dynamic: 1 });
    expect(measureDoneSites("// transition(id, { to: 'done' })")).toEqual({ done: 0, dynamic: 0 });
    expect(measureDoneSites("transition(id, { to: 'open', by: 'agent' })")).toEqual({ done: 0, dynamic: 0 });
  });

  it('SELF-TEST: the walk is non-vacuous — a collapsed corpus cannot pass this file', () => {
    expect(files().length).toBeGreaterThan(300);
    expect(files()).toContain('work/store.ts');
    expect(files()).toContain('work/ask-settlement.ts');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PART B — NO ASK SURVIVES ITS TURN'S FINALIZE STILL `claimed`
// ════════════════════════════════════════════════════════════════════════════════

const AGENT = 'kevin';
const CONV = 'conv-1';

const ownerInbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: AGENT, role: 'user', content: 'can you check the roof quote?',
  lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
  conversationId: CONV,
  inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  ...over,
});

describe('CENSUS B — the structural invariant: no `claimed` ask outlives its turn', () => {
  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    mockDb.current = db;
    runMigrations();
    db.pragma('foreign_keys = ON');
    db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`).run(AGENT);
    db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-1', ?, 'dashboard', 'owner')`).run(AGENT);
  });

  it('three turns, three endings, ZERO claimed survivors', () => {
    const db = mockDb.current!;
    const claim = (id: string, turn: number): void => {
      insertMessage(ownerInbound({ id }) as never);
      claimAsk(askIdForMessage(id), AGENT);
      stampClaimingTurn(askIdForMessage(id), turn);
    };
    // turn 1 — answered
    claim('m-answered', 1);
    db.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
       VALUES ('d-1', ?, 1, 'auto-route', 'dashboard', ?, 'delivered', datetime('now','+5 seconds'))`,
    ).run(AGENT, CONV);
    // turn 2 — said nothing at all
    claim('m-silent', 2);
    // turn 3 — delegated
    claim('m-delegated', 3);
    openDelegationJoin({
      agentId: AGENT, parentWorkId: askIdForMessage('m-delegated'),
      threads: [{ threadId: 'th-1', assigneeAgent: 'peer' }],
      replyConversationId: CONV, ttlAt: Date.now() + 600_000,
    });

    for (const turn of [1, 2, 3]) settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn });

    const survivors = db.prepare(
      `SELECT id, claimed_by_turn FROM work
        WHERE kind = 'ask' AND state = 'claimed' AND claimed_by_turn IN (1,2,3)`,
    ).all() as Array<{ id: string; claimed_by_turn: number }>;
    expect(survivors, 'a claimed ask whose turn has finalized is the fossil this task deletes').toEqual([]);

    const state = (id: string): string => (db.prepare('SELECT state FROM work WHERE id = ?')
      .get(askIdForMessage(id)) as { state: string }).state;
    expect(state('m-answered')).toBe('done');
    expect(state('m-silent'), 'no evidence means the owner is served again, never parked').toBe('open');
    expect(state('m-delegated'), 'delegated work outstanding means held, and visibly owed').toBe('blocked');
  });

  it('every ending is NON-TERMINAL or delivery-backed — nothing is quietly written off', () => {
    const db = mockDb.current!;
    insertMessage(ownerInbound({ id: 'm-silent' }) as never);
    claimAsk(askIdForMessage('m-silent'), AGENT);
    stampClaimingTurn(askIdForMessage('m-silent'), 9);
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 9 });
    const closedWithout = db.prepare(
      `SELECT count(*) AS c FROM work
        WHERE kind = 'ask' AND state IN ('done','failed','abandoned') AND result_delivery_id IS NULL`,
    ).get() as { c: number };
    expect(closedWithout.c).toBe(0);
  });

  it('ANTI-ROT: the invariant is enforced on the turn `finally` arm, not on a happy path', () => {
    // The adjudicator must sit inside the block that runs on EVERY exit path — a clean reply,
    // a decline, MAX_TOOL_LOOPS, a spin brake, an exception. `runTurnTeardown` IS that block
    // (the language's `finally`), and `finalizeTurnRecord` is the one it calls unconditionally.
    const adjudicator = engineFileContaining('settleAsksAtTurnFinalize(');
    expect(adjudicator, 'nothing in the engine adjudicates the turn ask set').not.toBeNull();
    const host = engineFileContaining('export async function runTurnTeardown');
    expect(host, 'the finally arm itself has gone missing').not.toBeNull();
    expect(host!.text, 'the finally arm must reach the adjudicator on every exit path')
      .toMatch(new RegExp(`${path.basename(adjudicator!.rel, '.ts').replace(/-/g, '\\-')}|finalizeTurnRecord\\(`));
    // …and the assembled-context set that feeds it is a READ, never a claim.
    const cp = fs.readFileSync(path.join(SRC, 'agent/v2/counterparty.ts'), 'utf8');
    expect(cp).toMatch(/export function assembledContextAsks\(/);
    expect(stripComments(cp).slice(stripComments(cp).indexOf('export function assembledContextAsks')))
      .not.toMatch(/^[\s\S]{0,2500}?transition\(/);
  });
});
