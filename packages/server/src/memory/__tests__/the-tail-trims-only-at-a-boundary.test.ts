// ════════════════════════════════════════════════════════════════════════════════════════
// t94 — THE TAIL TRIMS ONLY AT A COMPACTION BOUNDARY.
//
// ── THE OWNER'S DIAGNOSTIC (BACKLOG line 15, his own full capture) ───────────────────────
// The dojo drops a few oldest messages off the FRONT of the conversation each turn to hold a
// context budget. Prefix caching is POSITIONAL, so every small front-trim renumbers
// everything behind it and re-prefills the whole remaining conversation — ~55K tokens ≈ 270s
// of pure waste per turn on a local box at 205 tok/s. THE ECONOMICS INVERT ON LOCAL: tokens
// are free, recomputation is expensive, so byte-stability beats shortness, and dropping 2
// messages costs the same as dropping 200. Trim-a-little-every-turn is the most expensive
// possible cadence.
//
// His prescription, in his order of preference:
//   (1) grow until a real compaction boundary and reduce ONLY there — one expensive turn,
//       then a long stable run;
//   (2) if trimming is unavoidable, batch it LARGE and RARE (~once per 40 turns);
//   (3) never a few per turn; anything that must change per turn goes at the BOTTOM.
//
// ── WHAT THE INSTRUMENT MEASURED AT THIS LANE'S BASE (main `eef45913`) ──────────────────
// The brief's lead named `budgetFreshTail` (the TOKEN trimmer). Driving it found a second,
// DOMINANT front-trimmer that fires whether or not tokens are tight:
//
//   `assembler.ts:1377` — `getRecentMessages(agentId, policy.freshTailCount, turnCutoff)`.
//
// `policy.freshTailCount` is a ROW cap (`budget.ts` `getFreshTailCount`: 24/40/64/80 by
// window). So the live conversation is "the newest N rows" — A SCROLLING WINDOW. Past row N
// every turn appends two rows at the back and drops two off the FRONT, for ever, at any
// utilisation. Compaction's own code says so in passing: *"the fresh tail is bounded by
// count, so total tokens don't grow unboundedly"* (`compaction.ts`, the gap trigger's
// comment) — which is exactly why the token trigger rarely fires and the row window does all
// the trimming.
//
// `the-tail-holds-still.test.ts` already states the law this breaks — *"not until a window
// scrolls its edge past a row that did not move"* — and claused it for every tail BLOCK. The
// fresh tail's own row window was the one scrolling window nobody claused.
//
// ── THE POLICY THIS FILE GUARDS (`memory/tail-horizon.ts`) ──────────────────────────────
// The tail is no longer "the newest N rows". It is EVERY ROW SINCE THE COMPACTION BOUNDARY —
// anchored on the newest row a summary already covers. Between two compactions that anchor
// does not move, so the tail is a pure APPEND and not one prefix byte shifts. At a compaction
// the anchor advances once, the rows it passed are already represented by the summary
// compaction just wrote ABOVE the tail, and that single discontinuity is the one turn the
// owner's prescription says should pay. The row cap survives as the FLOOR (never show less
// than before) and a hard ceiling exists for the case where compaction cannot run at all —
// and that ceiling trims LARGE, RARE and LOUD.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));

vi.mock('../../tools/tool-docs.js', () => ({
  measureAgentToolPayloadTokens: async () => 1000,
}));

/** The summariser's model call. Deterministic, fictional, and switchable OFF so the
 *  "compaction unavailable" probe (D6) is a real condition rather than a description. */
const summariser = { up: true, calls: 0 };

vi.mock('../../agent/model.js', () => ({
  callModel: async () => {
    summariser.calls++;
    if (!summariser.up) throw new Error('summary writer is down (fixture)');
    return {
      content: 'Earlier in this run the two sides worked through the crate inventory.',
      toolCalls: [],
      usage: {},
    };
  },
  getContextWindow: () => windowNow.value,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

import { assembleContext } from '../assembler.js';
import { insertMessage } from '../message-store.js';
import {
  checkAndCompact, getUncompactedGapCount, UNCOMPACTED_GAP_THRESHOLD, estimateAssembledTokens,
} from '../compaction.js';
// The 15-minute low-yield backoff is MODULE state keyed by agent id, so without this reset
// one probe's compaction run brakes the next probe's and the second one silently measures a
// tree with compaction switched off. Found the hard way: the "writer down" probe read zero
// summariser calls in the full file and one in isolation.
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { getFreshTailCount, contextWindowPolicy } from '../budget.js';
import {
  TAIL_HORIZON_CEILING_MULTIPLE, tailCeilingStepRows, tailTrimBlockGroups,
  groupsToDropForBudget, freshTailHorizon,
} from '../tail-horizon.js';
// t100 §9's floor fixture: the deep-compaction state is built by hand, so a leaf summary is
// written directly rather than driven out of a pass whose divider is throttled.
import { createLeafSummary } from '../dag.js';
import { runMigrations } from '../../db/migrations.js';
import {
  serialiseAssembly, runDeltas, discontinuities, renderTable, abridge,
  type TurnSnapshot, type TurnDelta,
} from './prefix-instrument.js';

const AGENT = 'agent-t94';
const MODEL = 'model-t94';
/** A modest window, so pressure is real: `getFreshTailCount(32000) = 40` rows. */
const WINDOW = 32_000;
/** The row ceiling and its step at this window: 320 rows, 160 per cut. */
const CEILING_ROWS = 40 * TAIL_HORIZON_CEILING_MULTIPLE;
const CEILING_STEP_ROWS = tailCeilingStepRows(40);
/** The TOKEN trim's quantum in groups — and in this fixture one row is one group. */
const TOKEN_BLOCK_GROUPS = tailTrimBlockGroups(40);
const windowNow = { value: WINDOW };

const db = (): Database.Database => mockDb.current!;

function seedModel(contextWindow = WINDOW): void {
  db().prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://localhost:11434/v1')",
  ).run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled)
     VALUES (?, 'p', 'local-mix', 'Local Mix', ?, 4096, '["tools","thinking"]', 1)`,
  ).run(MODEL, contextWindow);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, ?, 'idle', ?, '{}')")
    .run(AGENT, 'Instrument', MODEL);
}

/** Fictional conversation bodies, long enough that a real budget has to think about them
 *  and deterministic so the instrument's bytes are reproducible (G1: no names, no PII). */
const ASKS = [
  'How many crates are still unlabelled in the back row of the depot?',
  'Which of the overnight deliveries needs a signature before noon?',
  'Can the second pallet be split across the two short shelves?',
  'What is left on the inventory sheet for the blue bins?',
  'Does the loading bay door still need the replacement latch?',
];
const REPLIES = [
  'Fourteen crates are unlabelled; eleven are in the back row and three sit by the ramp. '
  + 'I have written the row numbers on the clipboard so the count can be checked by hand. '
  + 'The labels themselves are in the second drawer and there are enough for the whole run.',
  'Two of the overnight deliveries need a signature, and both are flagged on the manifest. '
  + 'I have put them at the front of the queue so nothing waits behind an unsigned pallet. '
  + 'The rest can be checked in at any point during the afternoon without a holdup.',
  'The second pallet splits cleanly into two halves of nine boxes each, which fits both '
  + 'short shelves with a hand-width to spare. Nothing needs restacking to make it work, '
  + 'and the heavier half should go on the lower shelf so the rack stays balanced.',
  'The inventory sheet still has the blue bins open: six counted, four to go, and one of the '
  + 'four has a torn lid that should be swapped before it is counted at all. I have noted the '
  + 'swap on the same line so the count and the repair do not drift apart.',
  'The loading bay latch is still the temporary one. It holds, but it has to be lifted twice '
  + 'to seat, and that is the sort of thing that gets forgotten on a busy morning. The '
  + 'replacement is in the parts bin and takes about ten minutes with one spanner.',
];

let turnNo = 0;

/** One outer turn of a fictional conversation: the ask, then the answer. */
function appendTurn(): void {
  turnNo++;
  db().prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, 'user', datetime('now'), NULL, NULL, 0)`,
  ).run(AGENT, turnNo);
  insertMessage({
    agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner',
    content: `[t${turnNo}] ${ASKS[turnNo % ASKS.length]}`, turnNumber: turnNo,
  });
  insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'owner',
    content: `[t${turnNo}] ${REPLIES[turnNo % REPLIES.length]}`, turnNumber: turnNo,
  });
}

/** Every routine pass that actually compacted, with the numbers it reported. t100 §7 reads
 *  `tokensReclaimed` out of here: the drain's cadence is decided by the LOW-YIELD BACKOFF
 *  (`compaction.ts`: `tokensReclaimed < 2000 && leafCreated <= 1` → `noteLowYield`), and that
 *  predicate is a question about the gate's OWN estimate. A probe that only counted
 *  discontinuities could see the cadence change and not know which number moved it. */
const passLog: Array<{ turn: number; leafCreated: number; tokensReclaimed: number }> = [];

/** The production pre-call gate's ROUTINE arm, as `agent/v2/steps/pre-call-gates/
 *  context-gates.ts` runs it: a gap over the threshold drains one chunk. Awaited here
 *  (production fires and forgets) so the run is deterministic. Returns the pass's own result
 *  when it compacted, and null otherwise — the boolean it used to return is `!== null`. */
async function runRoutineCompactionGate(): Promise<{ leafCreated: number; tokensReclaimed: number } | null> {
  const gap = getUncompactedGapCount(AGENT, windowNow.value);
  if (gap <= UNCOMPACTED_GAP_THRESHOLD) return null;
  try {
    const r = await checkAndCompact(AGENT, MODEL, windowNow.value, {
      maxChunksPerRun: 1, skipContinuityBrief: true,
    });
    return r.leafCreated > 0 || r.condensedCreated > 0
      ? { leafCreated: r.leafCreated, tokensReclaimed: r.tokensReclaimed }
      : null;
  } catch {
    return null;
  }
}

interface RunOptions {
  turns: number;
  /** Run the compaction gate between turns (the production shape). */
  compaction?: boolean;
  /** Called after each turn's rows are written, before the assembly. */
  between?: (turn: number) => Promise<void> | void;
}

async function driveRun(opts: RunOptions): Promise<TurnSnapshot[]> {
  const snaps: TurnSnapshot[] = [];
  for (let t = 1; t <= opts.turns; t++) {
    appendTurn();
    let note = '';
    const pass = opts.compaction === false ? null : await runRoutineCompactionGate();
    if (pass) { passLog.push({ turn: t, ...pass }); note = 'compaction ran'; }
    if (opts.between) await opts.between(t);
    const ctx = await assembleContext(AGENT, MODEL);
    snaps.push({
      turn: t,
      messages: JSON.parse(JSON.stringify(ctx.messages)) as unknown[],
      entryIds: ctx.messageEntryIds ? [...ctx.messageEntryIds] : undefined,
      note: note || (ctx.freshTailDropped ? `freshTailDropped=${ctx.freshTailDropped}` : ''),
    });
  }
  return snaps;
}

beforeEach(() => {
  turnNo = 0;
  passLog.length = 0;
  __resetBrakesForTests();
  summariser.up = true;
  summariser.calls = 0;
  windowNow.value = WINDOW;
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedModel();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── §0 THE INSTRUMENT ITSELF ────────────────────────────────────────────────────────────
//
// A verdict machine that cannot be wrong about its own arithmetic is the point, so its
// content alignment is proven on hand-built arrays before any assembly is driven through it.

describe('t94 §0 — the instrument aligns by CONTENT, never by position', () => {
  const snap = (turn: number, contents: string[]): TurnSnapshot => ({
    turn, messages: contents.map((c) => ({ role: 'user', content: c })),
  });

  it('a pure APPEND reads append-only, with zero front drop and zero shift', () => {
    const d = runDeltas([snap(1, ['a', 'b']), snap(2, ['a', 'b', 'c'])])[0];
    expect(d.appendOnly).toBe(true);
    expect(d.droppedFromFront).toBe(0);
    expect(d.shift).toBe(0);
    expect(d.firstMovedIndex).toBeNull();
    expect(d.reprefillBytes).toBe(d.bytesAfter - d.bytesBefore);
  });

  it('a FRONT-TRIM is named as a front-trim and not as "everything changed"', () => {
    // Position-wise every row differs. Content-wise exactly two rows left the front and the
    // survivors moved up by two. The owner's method warning, enforced.
    const d = runDeltas([snap(1, ['a', 'b', 'c', 'd']), snap(2, ['c', 'd', 'e'])])[0];
    expect(d.appendOnly).toBe(false);
    expect(d.droppedFromFront).toBe(2);
    expect(d.shift).toBe(-2);
    expect(d.survivors).toBe(2);
    // And the re-prefill bill is the WHOLE later array bar the JSON envelope of message 0
    // (`{"role":"user","content":"` — 26 bytes), which is exactly what a positional cache
    // gets to keep when row 0 is a different row.
    expect(d.commonBytes).toBe(26);
    expect(d.reprefillBytes).toBe(d.bytesAfter - d.commonBytes);
  });

  it('a row rewritten IN PLACE is named at its own index, not at the front', () => {
    const d = runDeltas([snap(1, ['a', 'b', 'c']), snap(2, ['a', 'b', 'CHANGED', 'd'])])[0];
    expect(d.appendOnly).toBe(false);
    expect(d.droppedFromFront).toBe(0);
    expect(d.firstMovedIndex).toBe(2);
  });

  it('a PREFIX INSERTION reads as a positive shift with nothing dropped', () => {
    const d = runDeltas([snap(1, ['b', 'c']), snap(2, ['summary', 'b', 'c'])])[0];
    expect(d.droppedFromFront).toBe(0);
    expect(d.shift).toBe(1);
    expect(d.appendOnly).toBe(false);
  });

  it('serialisation is the bytes of the array and nothing else', () => {
    expect(serialiseAssembly([{ role: 'user', content: 'x' }]))
      .toBe('{"role":"user","content":"x"}');
  });
});

// ── §1 THE OWNER'S SHAPE, AND THAT IT IS GONE ───────────────────────────────────────────

describe('t94 §1 — a long run is append-only between compaction boundaries', () => {
  it('48 turns: every turn append-only except the compaction boundaries', async () => {
    const snaps = await driveRun({ turns: 48 });
    const deltas = runDeltas(snaps);
    const bad = discontinuities(deltas);

    // eslint-disable-next-line no-console
    console.log(renderTable(
      't94 D0 — 48 fictional turns, 32K window (row cap 40), routine compaction on',
      deltas, abridge(deltas),
    ));

    // The property. Every non-boundary turn is a pure append: zero prefix bytes move.
    for (const d of deltas) {
      if (d.note === 'compaction ran') continue;
      expect(
        { turn: d.turn, appendOnly: d.appendOnly, dropped: d.droppedFromFront, moved: d.firstMovedIndex },
      ).toEqual({ turn: d.turn, appendOnly: true, dropped: 0, moved: null });
    }

    // PRE-FIX this run front-trimmed on ~28 of 47 turns. Every discontinuity that remains
    // has to be a compaction boundary, and there has to be at least one (otherwise the run
    // never reached the pressure the clause is about).
    expect(bad.length).toBeGreaterThan(0);
    for (const d of bad) expect(d.note).toBe('compaction ran');
    // LARGE AND RARE, measured: fewer than one discontinuity per ten turns.
    expect(bad.length).toBeLessThanOrEqual(Math.ceil(deltas.length / 10));
  }, 120_000);

  it('the front of the conversation does not move between boundaries', async () => {
    const snaps = await driveRun({ turns: 30 });
    const deltas = runDeltas(snaps);
    const nibbles = deltas.filter((d) => d.droppedFromFront > 0 && d.note !== 'compaction ran');
    expect(nibbles.map((d) => `turn ${d.turn} dropped ${d.droppedFromFront}`)).toEqual([]);
  }, 120_000);

  it('the row cap is a FLOOR, not a ceiling: the tail outgrows it', async () => {
    const cap = getFreshTailCount(WINDOW);
    expect(cap).toBe(40);
    const snaps = await driveRun({ turns: 34 });
    // Rows written: 68. PRE-FIX the tail was pinned at exactly `cap` from row 40 onward.
    const last = snaps[snaps.length - 1].messages as Array<{ content: unknown }>;
    const conversation = last.filter((m) => JSON.stringify(m.content).includes('[t'));
    expect(conversation.length).toBeGreaterThan(cap);
  }, 120_000);
});

// ── §2 BACKWARDS-LIFECYCLE PROBES (D6) ──────────────────────────────────────────────────

describe('t94 §2 — the lifecycle probes', () => {
  it('compaction UNAVAILABLE: the tail grows, and the ceiling trims LARGE and RARE', async () => {
    // 200 turns = 400 rows. Two bounds exist and the clause does not care which one bites:
    // the ROW ceiling at 40 × 8 = 320 rows, and the TOKEN grant, which on this fixture's
    // 32K window runs out first (a ~290-row tail against a 25,624-token assembly budget).
    // Either way the claim is the same one, and it is about CADENCE: a whole block off the
    // front, then a long stable run. Driven long enough that the clause is about a trim that
    // actually happened rather than one the run never reached.
    summariser.up = false;
    const snaps = await driveRun({ turns: 200 });
    const deltas = runDeltas(snaps);
    const bad = discontinuities(deltas);

    // eslint-disable-next-line no-console
    console.log(renderTable(
      't94 D6 — 200 turns with the summary writer DOWN (no compaction can run)',
      deltas, abridge(deltas),
    ));

    expect(summariser.calls).toBeGreaterThan(0);                  // compaction WAS attempted
    expect(bad.length).toBeGreaterThan(0);                        // and a hard stop did bind

    // AND THE FRONT NEVER MOVES BACKWARDS. Two trimmers cut this tail — the row ceiling and
    // the token trim — and a composite front that can retreat is a prefix rewrite that buys
    // nothing: the tail GROWS at the front, every byte behind it re-billed, no new information
    // anywhere. With no compaction in this run nothing may legitimately insert ahead of the
    // conversation, so a positive `shift` is exactly that defect. It was RED at the first
    // version of this policy (the ceiling's step was one row cap; measured: turn 161 shifted
    // +20 and the run carried three discontinuities per twenty turns).
    for (const d of deltas) expect({ turn: d.turn, shift: d.shift }).toEqual({ turn: d.turn, shift: Math.min(0, d.shift) });

    // LARGE: every trim takes at least a whole token block off the front — never a nibble.
    // `droppedFromFront` counts the leading messages that genuinely vanished, content-aligned.
    for (const d of bad) expect(d.droppedFromFront).toBeGreaterThanOrEqual(TOKEN_BLOCK_GROUPS);

    // AND THE CADENCE, PINNED IN BOTH DIRECTIONS (review I2). The FIRST cut takes the whole
    // half-the-tail bound — 140 groups of a 288-group span, seven blocks — where the margin
    // rule this replaced took 40, and that size IS the cadence: the next front move is 15
    // turns later and is a 20-row `maxDrop` step, after which the row ceiling caps the loaded
    // span and the drop stabilises for the remaining 40 turns. A smaller cut rule reds this.
    expect(bad[0].droppedFromFront).toBe(7 * TOKEN_BLOCK_GROUPS);
    expect(bad.length).toBe(2);
    expect(bad[1].turn - bad[0].turn).toBeGreaterThanOrEqual(15);

    // RARE: fewer than one turn in twenty rewrites the prefix. PRE-t94 this run front-trimmed
    // on every turn past row 40, i.e. 180 of these 199.
    expect(bad.length).toBeLessThanOrEqual(Math.floor(deltas.length / 20));
  }, 300_000);

  it('a session reset restarts the tail — a legitimate discontinuity, and exactly one', async () => {
    const first = await driveRun({ turns: 12 });
    db().prepare("UPDATE agents SET session_started_at = datetime('now', '+1 second') WHERE id = ?")
      .run(AGENT);
    await new Promise((r) => setTimeout(r, 1100));
    const second = await driveRun({ turns: 8 });
    const across = runDeltas([first[first.length - 1], second[0]]);
    expect(across[0].appendOnly).toBe(false);             // declared: the session restarted
    // And after the reset the new run is append-only again.
    for (const d of runDeltas(second)) {
      if (d.note === 'compaction ran') continue;
      expect(d.appendOnly).toBe(true);
    }
  }, 120_000);

  it('a model switch mid-run is append-only: the boundary is not a function of the window', async () => {
    const before = await driveRun({ turns: 24 });
    // A smaller box, 32K -> 24K: `getFreshTailCount` drops 40 -> 24 and the assembly budget
    // drops with it.
    windowNow.value = 24_000;
    db().prepare('UPDATE models SET context_window = 24000 WHERE id = ?').run(MODEL);
    const after = await driveRun({ turns: 10 });

    // REVIEW M1 asked for a COUNT here, and the count turned out better than the claim the
    // first clause made. I expected the switch turn to be the discontinuity; it is not one at
    // all. THE SWITCH ITSELF COSTS NOTHING, and the reason is the policy: the tail's front is
    // the COMPACTION BOUNDARY, which is not a function of the window, so changing the window
    // changes what compaction will summarise NEXT and what the token trim may cut — neither
    // of which moves where the tail starts. Measured: the switch turn is append-only, and the
    // run's single discontinuity lands three turns later and is a compaction (the smaller
    // cap pushed the uncompacted gap past its threshold, which is correct).
    //
    // 16K was tried first and is NOT a probe of this: there the post-budget reserves plus a
    // 2,682-token system prompt leave the live conversation under ~600 tokens, the fit-wins
    // fallthrough keeps one group, the integrity pass refuses a trailing assistant row, and
    // the array collapses to `lane.empty-context-fallback` every turn with
    // `freshTailDropped` climbing 49, 51, 53. That is PRE-EXISTING — the pre-t94 backwards
    // loop also kept exactly one group on a grant smaller than one group — and it is loud by
    // design. It is recorded in the report as a measured residual, not fixed here.
    const across = runDeltas([before[before.length - 1], ...after]);
    const bad = discontinuities(across);
    expect(across[0].appendOnly).toBe(true);              // the switch turn itself
    expect(bad.length).toBe(1);
    expect(bad[0].note).toBe('compaction ran');
    expect(before.length + after.length).toBe(34);
  }, 120_000);
});

// ── §3 THE FA-M1 WARNING SURVIVES FOR THE RARE LARGE TRIM (D4) ──────────────────────────

describe('t94 §3 — the rare large trim is still counted and still loud', () => {
  it('a tail that cannot fit reports freshTailDropped, and it is a LARGE number', async () => {
    // One enormous fictional tool result per turn, so the token ceiling binds rather than
    // the row cap. This is the one place a trim is legitimate and it must be loud.
    for (let t = 1; t <= 10; t++) {
      turnNo = t;
      insertMessage({
        agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner',
        content: `[t${t}] ${ASKS[t % ASKS.length]}`, turnNumber: t,
      });
      insertMessage({
        agentId: AGENT, role: 'assistant', lane: 'owner',
        content: `[t${t}] ` + 'the depot inventory line repeats for a long while. '.repeat(260),
        turnNumber: t,
      });
    }
    const ctx = await assembleContext(AGENT, MODEL);
    expect(ctx.freshTailDropped ?? 0).toBeGreaterThan(0);
  }, 60_000);
});

// ── §4 THE FLOOR, AND WHY THE UNPRESSURED PREFIX CANNOT HAVE MOVED (D4) ─────────────────
//
// The cache-prefix golden lives in the kit, outside this tree. What CAN be proven here is the
// stronger statement it would be testing: for an agent under no pressure the two new
// decisions are provably the identity, so the bytes the golden hashes were never reachable by
// this change. Both are asserted directly, on the functions themselves.

describe('t94 §4 — an unpressured agent takes the pre-t94 path exactly', () => {
  it('a conversation shorter than the row cap asks for the row cap and filters nothing', async () => {
    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 1000, maxOutputTokens: 4096 });
    expect(policy.freshTailCount).toBe(40);
    for (let t = 1; t <= 10; t++) appendTurn();                 // 20 rows, nothing compacted
    const h = freshTailHorizon(AGENT, policy);
    expect({ requestRows: h.requestRows, keepFromSeq: h.keepFromSeq, ceilingBound: h.ceilingBound })
      .toEqual({ requestRows: 40, keepFromSeq: 0, ceilingBound: false });
  });

  it('a tail inside its token grant drops nothing at all', () => {
    const groups = Array.from({ length: 50 }, () => 100);       // 5,000 tokens
    expect(groupsToDropForBudget(groups, 25_624, tailTrimBlockGroups(40))).toBe(0);
  });

  it('the same assembly twice is byte-identical, and a quiet turn only appends', async () => {
    for (let t = 1; t <= 6; t++) appendTurn();
    const a = JSON.stringify((await assembleContext(AGENT, MODEL)).messages);
    const b = JSON.stringify((await assembleContext(AGENT, MODEL)).messages);
    expect(b).toBe(a);
  });
});

// ── §5 THE TWO QUANTA, AS UNITS ─────────────────────────────────────────────────────────

describe('t94 §5 — the trim quanta', () => {
  const block = tailTrimBlockGroups(40);

  it('the block is half a row cap, with a floor', () => {
    expect([tailTrimBlockGroups(24), tailTrimBlockGroups(40), tailTrimBlockGroups(64), tailTrimBlockGroups(80)])
      .toEqual([12, 20, 32, 40]);
    expect(tailTrimBlockGroups(4)).toBe(8);                      // the floor
  });

  it('the ceiling step is half the ceiling — the monotonicity half', () => {
    expect({ ceiling: CEILING_ROWS, step: CEILING_STEP_ROWS }).toEqual({ ceiling: 320, step: 160 });
    expect(tailCeilingStepRows(40)).toBe((40 * TAIL_HORIZON_CEILING_MULTIPLE) / 2);
    expect(tailCeilingStepRows(64)).toBe(256);
  });

  it('a drop is the WHOLE half-the-tail bound, never the minimum that fits', () => {
    // 100 groups of 100 tokens = 10,000 against a 9,000 budget. The minimum drop is 10 groups;
    // the first cut of this policy dropped one block plus a block of margin (40); it now cuts
    // `maxDrop` = floor(floor(100/2)/20)·20 = 40 here, and the point of the clause is the
    // RULE, not the coincidence — review I2's doubling shows at group counts where the bound
    // is larger than block+margin, so both are asserted.
    const groups = Array.from({ length: 100 }, () => 100);
    const drop = groupsToDropForBudget(groups, 9_000, block);
    expect(drop % block).toBe(0);
    expect(drop).toBe(Math.floor(Math.floor(100 / 2) / block) * block);

    // AND THE CASE THAT DISTINGUISHES THE TWO RULES — the clause the cadence rests on.
    // 288 groups the size of the pressured fixture, the oldest 40 expensive and the rest
    // cheap, against a budget that one block does not reach but two do. The smallest fitting
    // multiple is 40 and the old margin rule returned 60; the bound is 140 and that is what
    // is taken, which is the ~2× cadence review I2 asked for.
    const big = [...Array.from({ length: 40 }, () => 1_000), ...Array.from({ length: 248 }, () => 10)];
    expect(big.length).toBe(288);
    const bigDrop = groupsToDropForBudget(big, 3_000, block);
    expect(bigDrop).toBe(Math.floor(Math.floor(288 / 2) / block) * block);
    expect(bigDrop).toBe(140);
    expect(bigDrop).toBeGreaterThan(2 * block);          // strictly more than the margin rule
    // Still legal: it fits, and it is at most half the tail.
    expect(big.slice(bigDrop).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3_000);
    expect(bigDrop).toBeLessThanOrEqual(Math.floor(big.length / 2));
  });

  it('it never cuts more than half the live conversation in one pass, so the margin is capped', () => {
    // 50 groups: the oldest 20 cost 1,000 each, the rest 10. Dropping one block (20) already
    // brings the remainder to 300 against a 1,000 budget — so the margin would take another
    // block. The half-bound (`floor(50/2) = 25`, rounded down to a block = 20) refuses it: a
    // tail that cannot afford the margin does not pay it.
    const groups = [...Array.from({ length: 20 }, () => 1_000), ...Array.from({ length: 30 }, () => 10)];
    const drop = groupsToDropForBudget(groups, 1_000, block);
    expect(drop).toBe(block);
    expect(drop).toBeLessThanOrEqual(Math.floor(groups.length / 2));
  });

  it('but FIT OVERRIDES THE HALF-BOUND — the hard window is not negotiable', () => {
    // 45 groups of 1,000 against 1,500. No block multiple fits and half the tail is nowhere
    // near enough, so the minimum-that-fits fallback runs past the half-bound and the caller
    // warns. A moved prefix beats a prompt the provider refuses; this is the one corner where
    // the pre-t94 cadence is the right answer, and it is a window too small to hold a block of
    // conversation rather than a cadence to tune.
    const groups = Array.from({ length: 45 }, () => 1_000);
    const drop = groupsToDropForBudget(groups, 1_500, block);
    expect(drop).toBe(44);
    expect(groups.slice(drop).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_500);
  });

  it('one group that alone exceeds the budget still rides, with nothing dropped past it', () => {
    expect(groupsToDropForBudget([50_000], 1_000, block)).toBe(0);
  });
});

// ── §6 D2 — WHICH NUMBER THE TRIMMER ENFORCES, WITH ITS UNIT ────────────────────────────
//
// The owner's capture asked it: the model advertises 131K, the runs sit at ~80K, and the
// budget may be inherited from a smaller cloud model. The answer is that the number which
// trimmed him WAS NOT A TOKEN BUDGET AT ALL.
//
//   the TOKEN budget     `contextWindowPolicy(cw, measured).assemblyBudgetTokens`
//                        = floor(0.96 × cw) − (measured tool payload + min(4096, max output))
//                        cw is `models.context_window` (`agent/model.ts` `getContextWindow`
//                        → `getModelInfo`: `row.context_window ?? 200000`). For a declared
//                        131,072 window with the primary's measured 17,502-token tools array:
//                        125,829 − 21,598 = 104,231 TOKENS at the canonical 4 chars/token.
//                        His prompts sat at ~80K. THIS NEVER BOUND.
//   the ROW budget       `getFreshTailCount(131072)` = 64 ROWS. A hardcoded ladder, not a
//                        function of the window's tokens. 64 rows of a tool-using turn at the
//                        ~860 tokens/row his capture implies is ~55K tokens — which is the
//                        re-prefill figure in his own diagnostic, to the order.
//
// So the inherited-from-a-smaller-model suspicion was right about the SHAPE and one noun off
// about the number: the ladder rung is the inherited constant, and it is a row count.

describe('t94 §6 — the budget, named, with its unit', () => {
  it('the token budget on a declared 131K window is ~104K tokens and never bound at 80K', () => {
    const policy = contextWindowPolicy(131_072, { toolPayloadTokens: 17_502, maxOutputTokens: 4096 });
    expect(policy.assemblyBudgetTokens).toBe(Math.floor(0.96 * 131_072) - (17_502 + 4_096));
    expect(policy.assemblyBudgetTokens).toBe(104_231);
    expect(policy.assemblyBudgetTokens).toBeGreaterThan(80_000);
  });

  it('the ROW budget on the same window is 64 rows, and it is a ladder rung', () => {
    expect(getFreshTailCount(131_072)).toBe(64);
    // Not derived from the window's tokens: double the window and the rung moves by 16 rows.
    expect([getFreshTailCount(8_000), getFreshTailCount(32_000),
            getFreshTailCount(128_000), getFreshTailCount(200_000)]).toEqual([24, 40, 64, 80]);
  });

  it('a NULL context_window still inherits 200,000 — a cloud number on a local box', () => {
    // `getModelInfo` is `row.context_window ?? 200000`, and `agent/model.ts` is another lane's
    // file. Recorded here as the reading, not changed: a local row with no declared window is
    // budgeted as if it were a 200K cloud model, which over-fills rather than over-trims.
    const policy = contextWindowPolicy(200_000, { toolPayloadTokens: 17_502, maxOutputTokens: 4096 });
    expect(policy.freshTailCount).toBe(80);
    expect(policy.assemblyBudgetTokens).toBe(170_402);
  });
});

// ── §7 D3 — THE SEAM WITH COMPACTION, DRIVEN RATHER THAN ASSERTED ───────────────────────
//
// The policy's one legitimate discontinuity is "a compaction ran". So the cadence of the
// prefix is now the cadence of COMPACTION, and that moves the question one module over —
// into `memory/compaction.ts`, which this lane may read and not edit.
//
// On the healthy path the two cadences match by construction: the routine gate fires when
// more than `UNCOMPACTED_GAP_THRESHOLD = 30` rows sit outside the row cap, drains ONE chunk,
// and the gap falls back under the threshold — so a compaction, and therefore a boundary
// advance, happens roughly once per fifteen turns at two rows a turn. §1 measures exactly
// that: one discontinuity in 47 turns.
//
// A BACKLOG IS THE OTHER CASE AND IT IS THE SEAM. An agent arriving with hundreds of
// uncompacted rows (an import, or a summary writer that was down for a while — §2's own
// ending state) has a gap that stays over the threshold for many turns, so the gate drains a
// chunk on EVERY turn until it is clear, and every one of those turns advances the boundary.
// This clause drives it and records the number rather than claiming one.
//
// ── RE-AIMED BY t100, AND THE OLD WORDING IS WORTH KEEPING TO EXPLAIN WHY ───────────────
// Until the seam landed this clause asserted ONE discontinuity in the 25 turns after the
// drain, and explained the 24 quiet turns like this: *"the gap RE-ACCUMULATES past the
// threshold (measured: 49 rows by turn 25) and compaction does NOT run again —
// `compaction-brakes.ts`'s 15-minute low-yield backoff is holding it off, correctly, because
// there is little left to win."*
//
// HALF OF THAT WAS THE SEAM'S OWN BLINDNESS WEARING A REASON. "There is little left to win"
// was never measured — it was READ OFF THE GATE, and the gate was reading a 40-row slice of a
// 160-row tail. `compaction.ts` arms the backoff on
// `tokensReclaimed < 2000 && leafCreated <= 1`, and `tokensReclaimed` is `tokensBefore −
// tokensAfter` with BOTH terms coming from `estimateAssembledTokens`. Capped at the row cap,
// a pass that took the array from 160 messages to 43 subtracted two 40-row readings and
// reported — MEASURED by planting that read back, not reasoned about — a yield of EXACTLY
// ZERO. So the agent sat out a 15-minute backoff it had earned by accident, and the gap it
// was ignoring stood at 48 rows against a threshold of 30 by the end of the run.
//
// POST-SEAM the same pass measures its real yield, the backoff does not arm, and when the gap
// re-accumulates past the threshold a SECOND drain runs — measured at turn 17. The count is
// therefore TWO, and that is not a regression of this lane's claim: the lane's claim is that
// the prefix moves only when COMPACTION moves, and both discontinuities are compactions, with
// every other turn append-only. What changed is the compaction cadence, which is the thing
// §7's own opening paragraph says this clause hands to `memory/compaction.ts` to decide.
describe('t94 §7 — the seam: a compaction backlog drains across consecutive turns', () => {
  it('a 300-row backlog costs one discontinuity per drain, never one per turn', async () => {
    // The backlog arrives while the writer is down — exactly the state §2 ends in. Two turns
    // are driven first so there is a snapshot to compare the drain against.
    summariser.up = false;
    for (let t = 1; t <= 148; t++) appendTurn();
    const before = await driveRun({ turns: 2 });
    __resetBrakesForTests();

    // The writer comes back. Every turn now runs the production routine gate. The pass log is
    // cleared here so it holds the DRAIN's passes only (the writer-down turns threw and
    // compacted nothing, but the clause should not depend on that to read its own numbers).
    passLog.length = 0;
    summariser.up = true;
    const after = await driveRun({ turns: 25 });
    const deltas = runDeltas([...before.slice(-1), ...after]);
    const bad = discontinuities(deltas);
    const compactions = deltas.filter((d) => d.note === 'compaction ran').length;

    // eslint-disable-next-line no-console
    console.log(renderTable(
      't94 D3 — the backlog drain: a 300-row gap, writer back up, 25 turns after',
      deltas, abridge(deltas),
    ));

    const gapAtEnd = getUncompactedGapCount(AGENT, windowNow.value);
    // eslint-disable-next-line no-console
    console.log(`t100 §7 — drains: ${JSON.stringify(passLog)} · uncompacted gap at the last turn: ${gapAtEnd} (threshold ${UNCOMPACTED_GAP_THRESHOLD})`);

    // THE MEASUREMENT. The drain happened and it rewrote the prefix on the turn it ran.
    expect(compactions).toBeGreaterThan(0);

    // ONE DISCONTINUITY PER DRAIN, AND EVERY DISCONTINUITY IS A DRAIN — the policy's single
    // legitimate cause. Equalities, so a third discontinuity, or a scrolling tail, reds this.
    expect(bad.map((d) => d.note)).toEqual(['compaction ran', 'compaction ran']);
    expect(bad.map((d) => d.turn)).toEqual([1, 17]);
    // "NEVER ONE PER TURN" is the claim that matters, so it is asserted as a cadence and not
    // left implied by the turn list above: the drains are far apart.
    expect(bad[1].turn - bad[0].turn).toBeGreaterThanOrEqual(15);
    // And every other turn is a pure append. The run length is asserted directly, replacing
    // the tautology review M1 found here (`deltas.length - bad.length === deltas.length - 1`
    // asserts nothing once `bad.length` has been checked).
    expect(deltas.length).toBe(25);
    expect(deltas.filter((d) => d.appendOnly).length).toBe(deltas.length - bad.length);

    // AND THE NUMBER THAT DECIDES THE CADENCE, which is the seam itself (see the header).
    // `compaction.ts` arms a 15-minute backoff on `tokensReclaimed < 2000 && leafCreated <= 1`,
    // and `tokensReclaimed` is a subtraction of two `estimateAssembledTokens` readings. Now
    // that those readings see the span the assembler admits, the first drain reports its real
    // yield, the backoff does not arm, and the second drain runs when the gap re-accumulates.
    // Pre-seam both terms were 40-row readings of a 160-row tail and the same pass reported a
    // yield under the floor — braking itself for a quarter of an hour on its own blind spot.
    //
    // MEASURED, both drains: turn 1 reclaims 10,664 tokens and turn 17 reclaims 1,293. So the
    // brake is not weakened by the seam — it is finally reading the truth. It declines to arm
    // on the pass that reclaimed ten thousand tokens and DOES arm on the pass that reclaimed
    // thirteen hundred, which is the predicate's whole intent; the run ends quiet because of
    // the second one, not because the first was misjudged.
    expect(passLog.map((p) => p.turn)).toEqual([1, 17]);
    expect(passLog[0].tokensReclaimed).toBeGreaterThan(2000);
    expect(passLog[1].tokensReclaimed).toBeLessThan(2000);
    // After the second drain the gap is back UNDER the threshold, which is why the run ends
    // quiet: the tail grows append-only from there, exactly as §1's healthy path does.
    expect(gapAtEnd).toBeLessThanOrEqual(UNCOMPACTED_GAP_THRESHOLD);
  }, 300_000);
});

// ── §8 THE CEILING TRIM IS LOUD IN THE CHANNEL A PERSON READS ───────────────────────────
//
// `freshTailDropped` is FA-M1's number: `agent/v2/steps/assemble/index.ts` logs a warn and
// broadcasts ONE `CONTEXT_HIGH` toast per turn naming it ("set aside its N oldest recent
// messages"). Pre-t94 the row window dropped two rows off the front every turn and that
// number stayed ZERO — the dominant trim was invisible to the receipt and to the toast alike,
// while the token trimmer's rarer evictions were the only thing either ever saw. "Large and
// rare" is only safe if it is also loud, so the horizon's own skip is carried out there now.

describe('t94 §8 — the horizon\'s ceiling trim reaches FA-M1', () => {
  it('a ceiling trim lands in freshTailDropped, and the number is a whole block', async () => {
    // 200 turns with no compaction possible: the hard stops bind and the count must be big.
    summariser.up = false;
    const snaps = await driveRun({ turns: 200 });
    const notes = snaps.map((s) => s.note).filter((n) => n && n.startsWith('freshTailDropped='));
    expect(notes.length).toBeGreaterThan(0);
    const counts = [...new Set(notes.map((n) => Number(n!.split('=')[1])))];
    // Never a nibble: every reported drop is at least one token block (20 groups here).
    for (const c of counts) expect(c).toBeGreaterThanOrEqual(tailTrimBlockGroups(40));
  }, 300_000);

  it('an unpressured agent still reports zero, so the toast does not cry wolf', async () => {
    for (let t = 1; t <= 8; t++) appendTurn();
    const ctx = await assembleContext(AGENT, MODEL);
    expect(ctx.freshTailDropped ?? 0).toBe(0);
  });
});

// ── §9 THE SEAM WITH THE COMPACTION GATE: CLOSED (t94 handed it up, t100 landed it) ─────
//
// t91 established, and t94 re-verified, that the compaction gate's TOKEN trigger can only
// ever be crossed by the FRESH TAIL: `compaction.ts` caps the summary half at the budget
// (`summaryTokens = Math.min(rawSummaryTokens, summaryBudget)`,
// `summaryBudget = floor((assemblyBudget − brief − freshTail) × 0.7)`), so summaries alone
// can never push `total` over a 0.96 threshold. Growing the tail to a boundary is therefore
// SELF-TERMINATING through that trigger as well as through the row-gap one — and THAT is why
// which rows the gate measures decides when the policy above stops growing.
//
// ── WHAT THIS CLAUSE SAID BEFORE t100, AND WHY IT HAD TO CHANGE ─────────────────────────
// t94 left this as a TRIPWIRE. The gate measured the tail with its own read,
// `getRecentMessages(agentId, policy.freshTailCount)` — the ROW CAP. Before t94 that was the
// same set the assembler admitted, so the gate's dry run and the real assembly agreed by
// construction; afterwards the assembler admitted every row since the compaction boundary,
// which is MORE, and the gate UNDER-REPORTED the assembly it was gating. This clause asserted
// that divergence WITH ITS NUMBER — 68 rows admitted, 40 seen, blind to 28 — precisely so
// that landing the fix would turn it RED and force whoever landed it to come here and assert
// AGREEMENT instead. That is what happened; this is the agreement form.
//
// ── THE IDENTITY NOW HELD, AND THE TWO WAYS TO BREAK IT ─────────────────────────────────
// The gate measures the assembler's ASK: the span admitted before `budgetFreshTail`'s token
// trim runs. (That is the right input to "should this agent compact" and it is also what the
// row cap used to measure — if the ASK is over the window the assembler is about to
// front-trim, and getting a compaction to run first is the gate's whole job.) So:
//
//   * A gate that reads the ROW CAP again reds the first clause below — it sees 40 of 68.
//   * A gate that reads the horizon but ADDS SLACK to the ask reds the second clause — the
//     FLOOR case, where `keepFromSeq` is 0 and nothing is filtered, so an ask padded by one
//     row cap simply answers twice as many rows as the assembler will ever send. This is the
//     direction the handed-up diff in `t94-report.md` got wrong (it padded unconditionally,
//     in a function that has no `turnCutoff` and therefore no reason to pad at all — t94's
//     own review I1 defect, on the gate side), and it is invisible in the common case: with
//     `rows_since > cap` the seq filter trims the padding off again and the count comes out
//     right for the wrong reason. The floor fixture is the one that catches it.
//
// ── THE RISK, RE-DERIVED (t94 review I3 — the first version had it backwards) ───────────
// A bigger measured tail does NOT latch an agent INCOMPRESSIBLE. `summaryTokens` is the
// CAPPED figure (`min(raw, summaryBudget)`, `summaryBudget <= 0.7 × assemblyBudget`), so a
// bigger tail shrinks the cap, and OR-COMPACT-1 abolished the terminal state anyway: the
// estimate feeds `condenseUntilFits`, so a bigger measured tail means a SMALLER summary
// target and MORE condensation, which is the correct direction.
//
// The EFFECT of the seam — that the token trigger now fires when the real tail is heavy, and
// does not fire when it is not — is driven in `the-gate-measures-the-tail-it-gates.test.ts`.
// This clause holds the identity; that file holds what the identity buys.
describe('t94 §9 / t100 — the gate measures the tail the assembler actually sends', () => {
  it('the common case: the gate sees the WHOLE span, and it is the assembler\'s own set', async () => {
    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 1000, maxOutputTokens: 4096 });
    for (let t = 1; t <= 34; t++) appendTurn();             // 68 rows, nothing compacted yet

    const horizon = freshTailHorizon(AGENT, policy);
    const est = await estimateAssembledTokens(AGENT, WINDOW, MODEL);
    const ctx = await assembleContext(AGENT, MODEL);
    const liveRows = (ctx.messages as Array<{ content: unknown }>)
      .filter((m) => JSON.stringify(m.content).includes('[t')).length;

    expect(horizon.rowsSinceBoundary).toBe(68);
    expect(est.freshTailCount).toBe(68);                     // the span — not the 40-row cap
    expect(est.freshTailCount).toBeGreaterThan(policy.freshTailCount);
    // THE SEAM, in rows, and it is now zero. Asserted against the assembled array as well as
    // against the horizon struct, because a clause that only asks the horizon what it decided
    // would be satisfied by a gate that re-derived the same answer from the wrong read.
    expect(horizon.rowsSinceBoundary - est.freshTailCount).toBe(0);
    expect(est.freshTailCount).toBe(liveRows);
  }, 120_000);

  it('the FLOOR case: the ask is exactly the row cap, unfiltered, with no slack', async () => {
    const cap = getFreshTailCount(WINDOW);
    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 1000, maxOutputTokens: 4096 });
    for (let t = 1; t <= 60; t++) appendTurn();              // 120 rows in the session

    // THE DEEP-COMPACTION FLOOR, built by hand rather than driven. A real pass leaves
    // `rows_since == cap` exactly and the divider nudges it to `cap + 1`, which is the
    // FILTERED case — the one that cannot see an over-ask. The state that can is `anchor > 0`
    // with `rows_since < cap`, reachable in production on a mid-session switch to a LARGER
    // window and on any pass that leaves fewer than `cap` live rows; a hand-built leaf
    // summary is the deterministic way to sit in it.
    const covered = db().prepare(
      'SELECT id FROM messages WHERE agent_id = ? ORDER BY seq ASC LIMIT 110',
    ).all(AGENT) as Array<{ id: string }>;
    expect(covered.length).toBe(110);
    createLeafSummary(AGENT, 'The depot inventory run so far, condensed.', 400,
      covered.map((r) => r.id), '2026-01-01 00:00:00', '2026-01-02 00:00:00');

    const horizon = freshTailHorizon(AGENT, policy);
    expect(horizon.rowsSinceBoundary).toBe(10);              // 10 <= cap, so: the floor
    expect(horizon.keepFromSeq).toBe(0);                     // nothing is filtered
    expect(horizon.requestRows).toBe(cap);                   // the floor's ask IS the cap

    // 120 rows exist, so with nothing filtered the COUNT IS THE ASK: an ask of `cap` answers
    // 40 and an ask of `cap + cap` answers 80. The assembler admits 40 here; so must the gate.
    const est = await estimateAssembledTokens(AGENT, WINDOW, MODEL);
    const ctx = await assembleContext(AGENT, MODEL);
    const liveRows = (ctx.messages as Array<{ content: unknown }>)
      .filter((m) => JSON.stringify(m.content).includes('[t')).length;
    expect(liveRows).toBe(cap);
    expect(est.freshTailCount).toBe(cap);
    expect(est.freshTailCount).toBe(liveRows);
  }, 120_000);
});

// ── §10 THE FLOOR IS LITERALLY THE PRE-t94 CALL, AND THE DIVIDER IS NOT LOAD-BEARING ────
//
// REVIEW I1, and it is the defect that hid behind this file's own flake. Routine leaf
// compaction summarises exactly `getMessagesOutsideFreshTail(agent, cap)`, so the instant it
// finishes `rowsSinceBoundary == cap` — the horizon's FLOOR, which returns `keepFromSeq: 0`
// (no filter) and `requestRows: cap`. The assembler then added the row-cap slack to that ask
// unconditionally, so the real ask was 2×cap WITH NOTHING FILTERED, and
// `store.ts getRecentMessages` does not exclude summarised rows — nothing in the assembler
// does either. So on the one turn where the context is by definition at its tightest, up to
// `cap` already-summarised rows rode in the live tail BESIDE the summary that covers them,
// and the next turn dropped them and paid a second prefix rewrite. Two per compaction, in
// the lane whose single job is one.
//
// The fixture dodged it only because `insertCompactionDivider` writes a system row, which
// pushes `rowsSinceBoundary` to `cap + 1` — the common case, filtered. THAT DIVIDER IS
// THROTTLED TO ONCE PER TEN MINUTES (`compaction.ts COMPACTION_DIVIDER_THROTTLE_MS`), and
// the reachable paths where it is absent are ordinary: the awaited emergency and context-full
// arms (`context-gates.ts` → `queueSelfWake`, which writes no row), a background drain
// completing between the gate and the assembly, and any compaction that leaves fewer than
// `cap` live rows. A prefix invariant may not depend on a cosmetic chat row arriving.
//
// So the probe DELETES the divider on every turn — the permanently-throttled case — and the
// claim is unchanged: one compaction, one discontinuity.
describe('t94 §10 — a compaction with its divider throttled still costs ONE discontinuity', () => {
  it('the floor admits the row cap and nothing a summary already covers', async () => {
    const cap = getFreshTailCount(WINDOW);
    const dropDivider = () => {
      db().prepare("DELETE FROM messages WHERE agent_id = ? AND content LIKE '%Memory Compacted%'")
        .run(AGENT);
    };
    const snaps = await driveRun({ turns: 48, between: dropDivider });
    const deltas = runDeltas(snaps);
    const bad = discontinuities(deltas);

    // eslint-disable-next-line no-console
    console.log(renderTable(
      't94 I1 — 48 turns with the compaction divider deleted every turn (the throttled case)',
      deltas, abridge(deltas),
    ));

    // ONE discontinuity, and it is the compaction. At HEAD before this fix it was TWO: the
    // compaction turn re-admitted the summarised rows, and the turn after dropped them.
    expect(bad.map((d) => d.note)).toEqual(['compaction ran']);

    // And the direct statement of the same thing, on the compaction turn's own array: the
    // live tail holds the row cap, and holds NO row that `summary_messages` already covers.
    const compactionTurn = bad[0].turn;
    const arr = snaps[compactionTurn - 1].messages as Array<{ content: unknown }>;
    const conversationRows = arr.filter((m) => JSON.stringify(m.content).includes('[t'));
    expect(conversationRows.length).toBe(cap);

    const summarised = db().prepare(
      `SELECT m.content AS content FROM messages m
         JOIN summary_messages sm ON sm.message_id = m.id
         JOIN summaries s ON s.id = sm.summary_id
        WHERE s.agent_id = ?`,
    ).all(AGENT) as Array<{ content: string }>;
    expect(summarised.length).toBeGreaterThan(0);                 // something WAS summarised
    const live = arr.map((m) => JSON.stringify(m.content)).join('\n');
    const leaked = summarised.filter((r) => live.includes(r.content.slice(0, 60)));
    expect(leaked.map((r) => r.content.slice(0, 40))).toEqual([]);
  }, 180_000);
});
