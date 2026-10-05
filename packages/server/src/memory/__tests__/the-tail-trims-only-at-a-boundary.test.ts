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

/** The production pre-call gate's ROUTINE arm, as `agent/v2/steps/pre-call-gates/
 *  context-gates.ts` runs it: a gap over the threshold drains one chunk. Awaited here
 *  (production fires and forgets) so the run is deterministic. */
async function runRoutineCompactionGate(): Promise<boolean> {
  const gap = getUncompactedGapCount(AGENT, windowNow.value);
  if (gap <= UNCOMPACTED_GAP_THRESHOLD) return false;
  try {
    const r = await checkAndCompact(AGENT, MODEL, windowNow.value, {
      maxChunksPerRun: 1, skipContinuityBrief: true,
    });
    return r.leafCreated > 0 || r.condensedCreated > 0;
  } catch {
    return false;
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
    if (opts.compaction !== false && await runRoutineCompactionGate()) note = 'compaction ran';
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

  it('a model switch mid-run moves the budget — one discontinuity, then stable again', async () => {
    const before = await driveRun({ turns: 24 });
    // A smaller box: `getFreshTailCount(16000) = 24` rows where 32K gave 40. 8K is below
    // this fixture's own system prompt (2,682 tokens against a 2,584 budget) and
    // `assertSystemPromptFits` throws there — correctly, and not what this probe is about.
    windowNow.value = 16_000;
    db().prepare('UPDATE models SET context_window = 16000 WHERE id = ?').run(MODEL);
    const after = await driveRun({ turns: 10 });
    for (const d of runDeltas(after).slice(1)) {
      if (d.note === 'compaction ran' || d.note.startsWith('freshTailDropped')) continue;
      expect(d.appendOnly).toBe(true);
    }
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

  it('a drop is a MULTIPLE of the block, never the minimum that fits', () => {
    // 100 groups of 100 tokens = 10,000 against a 9,000 budget. The minimum drop is 10
    // groups; the policy drops a block, plus a block of margin.
    const groups = Array.from({ length: 100 }, () => 100);
    const drop = groupsToDropForBudget(groups, 9_000, block);
    expect(drop % block).toBe(0);
    expect(drop).toBe(2 * block);
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
describe('t94 §7 — the seam: a compaction backlog drains across consecutive turns', () => {
  it('a 300-row backlog costs ONE discontinuity, not one per turn', async () => {
    // The backlog arrives while the writer is down — exactly the state §2 ends in. Two turns
    // are driven first so there is a snapshot to compare the drain against.
    summariser.up = false;
    for (let t = 1; t <= 148; t++) appendTurn();
    const before = await driveRun({ turns: 2 });
    __resetBrakesForTests();

    // The writer comes back. Every turn now runs the production routine gate.
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

    // THE MEASUREMENT. The drain happened, it rewrote the prefix, and it did so ONCE —
    // `getLeafChunkTokens`'s chunk swallowed the whole gap in a single pass, so "the prefix
    // moves when compaction moves" costs one turn here and not twenty-five.
    expect(compactions).toBeGreaterThan(0);
    // THE DRAIN COSTS AT MOST A COUPLE OF TURNS, not one per turn. The bound is a RANGE and
    // not an equality on purpose: a compaction pass is not deterministic across wall-clock
    // seconds here (the chunker, the archive high-water and the low-yield backoff all read
    // real time), and two runs of this probe measured 1 and 2 discontinuities for the same
    // 300-row backlog. What is stable, and what the clause is for, is that the rest of the
    // run only appends.
    expect(bad.length).toBeLessThanOrEqual(2);
    expect(deltas.length - bad.length).toBeGreaterThanOrEqual(20);

    // AND THE PART THAT MAKES THE SEAM A NON-ISSUE, which this probe found rather than
    // assumed. After the drain the gap RE-ACCUMULATES past the threshold (measured: 49 rows
    // by turn 25) and compaction does NOT run again — `compaction-brakes.ts`'s 15-minute
    // low-yield backoff is holding it off, correctly, because there is little left to win.
    // Pre-t94 those twenty-four turns each front-trimmed two rows while compaction was
    // backed off: the trimmer and the compactor disagreed about whether the conversation was
    // under pressure, and the trimmer won every turn. Now the tail simply GROWS through the
    // backoff, append-only, until compaction is ready — which is the whole point of the lane.
    expect(getUncompactedGapCount(AGENT, windowNow.value)).toBeGreaterThan(UNCOMPACTED_GAP_THRESHOLD);
    expect(deltas.filter((d) => d.appendOnly).length).toBe(deltas.length - bad.length);
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

// ── §9 THE HANDED-UP SEAM (D3), MEASURED AND PINNED ─────────────────────────────────────
//
// t91 established, and this was re-verified at this lane's HEAD, that the compaction gate's
// TOKEN trigger can only ever be crossed by the FRESH TAIL: `compaction.ts:206` caps the
// summary half at the budget (`summaryTokens = Math.min(rawSummaryTokens, summaryBudget)`,
// `summaryBudget = floor((assemblyBudget − brief − freshTail) × 0.7)`), so summaries alone
// can never push `total` over a 0.96 threshold. Growing the tail to a boundary is therefore
// SELF-TERMINATING through that trigger as well as through the row-gap one — which is the
// half of this seam that works.
//
// THE HALF THAT DOES NOT, AND IT IS THIS LANE'S TO HAND UP. The gate measures the tail with
// its OWN read, `compaction.ts:173`:
//
//     const freshTail = getRecentMessages(agentId, policy.freshTailCount);
//
// — the ROW CAP. Before t94 that was the same set the assembler admitted, so the gate's model
// and the real assembly agreed by construction. The assembler now admits every row since the
// compaction boundary, which is MORE, so the gate UNDER-REPORTS the assembly it is gating.
// Consequences, in order of how much they matter:
//   * The token trigger and `context-gates.ts`'s warn/compact/block rungs read low, so
//     preemptive compaction fires later than the real pressure warrants. Bounded, because the
//     ROW-GAP trigger (`UNCOMPACTED_GAP_THRESHOLD = 30` past the cap) is not token-based and
//     still fires on schedule — which is what keeps the healthy path honest.
//   * It is not a correctness hole: the assembler's own `assemblyBudgetTokens` and the block
//     trim still bound what is SENT, so no over-window prompt is built that was not built
//     before, and `refuseIfDoomed` is still the last guard.
// The one-line fix belongs in `memory/compaction.ts`, which this lane may read and not edit.
// The report carries the proposed diff.
//
// THIS CLAUSE IS THE TRIPWIRE, AND IT COUNTS BOTH WAYS (G4). It pins the divergence that
// exists today, with its number. When the gate is taught the horizon, this clause goes RED
// and whoever lands that fix must change it to assert AGREEMENT — which is the point: a seam
// recorded only in a report rots, and a seam recorded in a clause cannot.
describe('t94 §9 — the gate still measures the tail by the row cap (handed up)', () => {
  it('the gate sees the row cap while the assembler admits the whole span', async () => {
    const policy = contextWindowPolicy(WINDOW, { toolPayloadTokens: 1000, maxOutputTokens: 4096 });
    for (let t = 1; t <= 34; t++) appendTurn();             // 68 rows, nothing compacted yet

    const horizon = freshTailHorizon(AGENT, policy);
    const est = await estimateAssembledTokens(AGENT, WINDOW, MODEL);

    // What the assembler will admit, and what the gate thinks it will admit.
    expect(horizon.rowsSinceBoundary).toBe(68);
    expect(est.freshTailCount).toBe(policy.freshTailCount);  // 40 — the row cap, not 68
    expect(est.freshTailCount).toBeLessThan(horizon.rowsSinceBoundary);
    // The gate is blind to 28 of the 68 rows it is gating. That is the seam, in rows.
    expect(horizon.rowsSinceBoundary - est.freshTailCount).toBe(28);
  }, 120_000);
});
