// ════════════════════════════════════════════════════════════════════════════════════════
// T69b — THE TAIL HOLDS STILL. T67b's CROSS-TURN INVARIANCE GATE, EXTENDED PAST THE BOUNDARY.
//
// ── THE INCIDENT (owner's DS4-server agent, post-T67b) ──────────────────────────────────
// T67b moved the divergence from token ~0 to ~37,900 — the prefix fix worked. What remained
// is the TAIL: ~2,000–2,800 tokens recomputed on EVERY turn, ~11s of prefill per turn on his
// local server. His own diagnosis list named the class: timestamps taken at send time,
// relative-time drift ("2 hours ago" -> "3 hours ago"), nondeterministic sort/serialisation,
// per-turn counters. That is the same defect class W60's census found in the prefix, one
// region over.
//
// ── STEP-0, THE DEFINITIVE MEASUREMENT THIS FILE IS DERIVED FROM ────────────────────────
// Dev box, `2557747`, BehaviorBot, floor model, full context receipts, four consecutive turns
// with no mail/calendar/board event between them. The tail — `messages[volatileFrom..]` —
// diffed byte-for-byte across all three consecutive pairs:
//
//   =  msg.pending-nudge          326 chars  IDENTICAL
//   =  msg.turn-context           300 chars  IDENTICAL
//   =  engine.recent-outbound     216 chars  IDENTICAL
//   ≠  engine.recently-answered   589 chars  MOVED   <- FIRST DIVERGENCE on all three pairs
//   ≠  msg.relevant-memory      3,868 chars  MOVED   (carrying ~1,400 chars of BOARD STATE)
//   ≠  msg.directive              524 chars  MOVED   (deliberate: it IS the ask)
//   ≠  msg.current-time           344 chars  MOVED   (deliberate: it IS the clock)
//
//   re-billed from the first divergence: 5,325–5,380 chars ≈ 1,331–1,345 tokens PER TURN.
//
// Every differing line was named and classified. The classification is what this file
// encodes, and it has exactly two verdicts:
//
//   DELIBERATE — `engine.recently-answered` (its source is the last three answered asks of
//                THIS conversation, and a turn answers one), `msg.relevant-memory` (retrieved
//                against the LIVE ASK: roadmap #10 is the reason it rides the tail at all),
//                `msg.directive` (its content IS the newest ask) and `msg.current-time` (its
//                content IS the clock). These four are REGISTERED in §4 below, by id, and are
//                the only exemptions this gate grants. The first was added AFTER the fix was
//                measured, not before it: at `2557747` it was also a clock reader and it also
//                sat ahead of every stable block, and both of those are gone.
//   DEFECT     — everything else, and there were four kinds:
//                  (a) relative ages read off `Date.now()` in four blocks;
//                  (b) the HL5 board snapshot glued to the BACK of the per-ask retrieval, so
//                      every ask re-billed it;
//                  (c) the block that changes on every answered turn sitting AHEAD of the
//                      blocks that change rarely;
//                  (d) similarity-rank ordering rendered as presentation order, so the same
//                      SET of rows emitted different bytes when the ranking nudged.
//
// ── THE PROPERTY, STATED ONCE ───────────────────────────────────────────────────────────
// A tail block renders BYTE-IDENTICAL until its own SOURCE DATA changes. Not until the clock
// ticks, not until a retrieval re-ranks the same rows, not until a window scrolls its edge
// past a row that did not move. The three registered lanes above are the declared exceptions
// and they sit LAST, in that order, so what they cost is themselves and nothing behind them.
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

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));

import { runMigrations } from '../../db/migrations.js';
import { getRecentOutbound, renderRecentOutboundBlock } from '../../agent/v2/outbound-ledger.js';
import {
  recentlyAnsweredAsks, renderRecentlyAnsweredBlock, RECENTLY_ANSWERED_LIMIT,
} from '../../agent/v2/answered-edge.js';
import { buildOpenWorkInjection } from '../../work/obligations.js';
import { renderDeliveriesLane } from '../deliveries-lane.js';
import { renderRecallLane, renderRecalledBlock, renderCommitmentsBlock, type RecallLaneContext } from '../recall-lane.js';
import { MessageSlot } from '../../prompt/registry/types.js';
import { POST_BUDGET_ENTRY_LANE } from '../lanes.js';
import { engineFileWithBoth } from '../../agent/v2/__tests__/engine-sources.js';

const AGENT = 'agent-t69b';
const CONV = 'conv-t69b';
// The fixture's zero point is the REAL clock at module load, then frozen. It is not a fixed
// literal on purpose: two of the reads under test filter in SQL with `datetime('now', '-24
// hours')` / `'-48 hours'`, and SQLite's `now` is the PROCESS clock, which `vi.setSystemTime`
// does not move. A literal instant in the past would put every seeded row outside those
// windows and the clauses would pass over an empty set — the "green because nothing was
// measured" failure this suite exists to refuse.
const DAY_ONE = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;

let seq = 0;

function seedAgent(): void {
  mockDb.current!.prepare(
    "INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'T69b', 'idle', NULL, '{}')",
  ).run(AGENT);
  mockDb.current!.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES (?, ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(CONV, AGENT);
}

/** A user ask and the assistant reply that answered it, stamped with the migration-113 edge. */
function seedAnsweredPair(askText: string, answerText: string, atMs: number): { askId: string; answerId: string } {
  const db = mockDb.current!;
  seq += 1;
  const askId = `t69b-ask-${seq}`;
  const answerId = `t69b-ans-${seq}`;
  const ins = db.prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, role, lane, sender_id, content,
                           display_kind, display_tier, turn_number, provenance, authorized,
                           token_count, created_at, answer_message_id)
     VALUES (?, ?, ?, ?, 'owner', 'owner', ?, ?, 'user-visible', 1, 'live', 1, 10, ?, ?)`,
  );
  ins.run(answerId, AGENT, CONV, 'assistant', answerText, 'agent-text', atMs + 1000, null);
  ins.run(askId, AGENT, CONV, 'user', askText, 'user-text', atMs, answerId);
  return { askId, answerId };
}

function seedReceipt(text: string, recipient: string, atMs: number): string {
  seq += 1;
  const id = `t69b-r-${seq}`;
  mockDb.current!.prepare(
    `INSERT INTO tool_receipts (id, agent_id, tool, turn_number, sent_text, conv_key, verified,
                                tier, basis, recipient, created_at)
     VALUES (?, ?, 'imessage_send', 10, ?, 'k', 1, 1, 'provider-id', ?, ?)`,
  ).run(id, AGENT, text, recipient,
    new Date(atMs).toISOString().replace('T', ' ').slice(0, 19));
  return id;
}

function seedDelivery(text: string, atMs: number): void {
  // The delivery's quoted text is read THROUGH the receipt it points at, so the id has to be
  // the one `seedReceipt` actually wrote — not a second one built from the same counter.
  const rid = seedReceipt(text, 'Dave', atMs);
  seq += 1;
  const at = new Date(atMs).toISOString().replace('T', ' ').slice(0, 19);
  const row: Record<string, unknown> = {
    id: `t69b-d-${seq}`, agent_id: AGENT, turn_number: 10, tool: 'imessage_send',
    channel: 'imessage', recipient_id: '+15550000', recipient_display: 'Dave',
    conversation_id: CONV, message_id: null, receipt_id: rid, outcome: 'delivered',
    detail: null, created_at: at,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO deliveries (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`,
  ).run(row);
}

function seedWork(id: string, kind: string, title: string, openedAtMs: number, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, kind, agent_id: AGENT, requester: 'owner', root_kind: 'chat', root_id: CONV,
    conversation_id: CONV, state: 'open', intent: 'chat', wakes: 0, closes_thread: 0,
    title, opened_at: openedAtMs, updated_at: openedAtMs, closed_at: null, ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO work (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`,
  ).run(row);
}

const deliveriesCtx = () => ({
  agentId: AGENT, conversationId: CONV, counterpartyName: 'Dave',
  recipientHints: ['Dave'], alreadyVisible: () => false,
});

const recallCtx = (over: Partial<RecallLaneContext> = {}): RecallLaneContext => ({
  agentId: AGENT,
  includeVault: true,
  excludeIds: new Set<string>(),
  msgHits: [],
  vaultHits: [],
  alreadyAnsweredAskIds: new Set<string>(),
  bridgeLines: [],
  ...over,
});

const textOf = (r: { messages: Array<{ content: unknown }> } | null): string =>
  (r?.messages ?? []).map((m) => m.content as string).join('\n\n');

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
  vi.setSystemTime(DAY_ONE);
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedAgent();
});

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 THE CLOCK IS NOT A SOURCE. Four blocks, one clause each, +90 minutes and no row touched.
//
// 90 minutes crosses the `minutes -> hours` bucket AND the hour boundary above it, so a block
// that reads `Date.now()` at any resolution this codebase renders is caught. RED at
// `2557747` for all four: each rendered `relativeTimeAgo` / `relativeAge` off the wall clock.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T69b §1 — the tail\'s time terms are the RECORDED INSTANT, never the clock', () => {
  it('engine.recent-outbound is byte-identical 90 minutes later', () => {
    seedReceipt('the invoice is attached', 'Dave', DAY_ONE - 30 * MIN);
    seedReceipt('and the quote', 'Sam', DAY_ONE - 20 * MIN);

    const before = renderRecentOutboundBlock(getRecentOutbound(AGENT, 24, 5));
    expect(before).toContain('RECENT OUTBOUND');
    vi.setSystemTime(DAY_ONE + 90 * MIN);
    expect(renderRecentOutboundBlock(getRecentOutbound(AGENT, 24, 5))).toBe(before);
  });

  it('engine.recently-answered is byte-identical 90 minutes later', () => {
    seedAnsweredPair('what is the boat insurance number', 'It is 44-291.', DAY_ONE - 40 * MIN);
    seedAnsweredPair('and the policy start date', 'March 3rd.', DAY_ONE - 10 * MIN);

    const read = () => renderRecentlyAnsweredBlock(
      recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT),
    );
    const before = read();
    expect(before).toContain('RECENTLY ANSWERED');
    vi.setSystemTime(DAY_ONE + 90 * MIN);
    expect(read()).toBe(before);
  });

  it('msg.deliveries is byte-identical 90 minutes later', () => {
    seedDelivery('what is your Delta number?', DAY_ONE - 35 * MIN);
    const before = textOf(renderDeliveriesLane(deliveriesCtx()));
    expect(before).toContain('Dave');
    vi.setSystemTime(DAY_ONE + 90 * MIN);
    expect(textOf(renderDeliveriesLane(deliveriesCtx()))).toBe(before);
  });

  it('engine.open-work is byte-identical 90 minutes later', () => {
    seedWork('ask:t69b1', 'ask', 'send the roof quote to Bob', DAY_ONE - 50 * MIN);
    seedWork('cmt:t69b2', 'commitment', 'call the plumber back', DAY_ONE - 20 * MIN);

    const before = buildOpenWorkInjection(AGENT, CONV);
    expect(before).toContain('OPEN WORK');
    vi.setSystemTime(DAY_ONE + 90 * MIN);
    expect(buildOpenWorkInjection(AGENT, CONV)).toBe(before);
  });

  it('the recall lane\'s ANSWERED PAIRS are byte-identical 90 minutes later', () => {
    const p = seedAnsweredPair('how much was the Asana plan', 'About $395 a year for three seats.', DAY_ONE - 45 * MIN);
    const ctx = recallCtx({ msgHits: [{ sourceId: p.askId }] });

    const before = textOf(renderRecallLane(ctx));
    expect(before).toContain('ALREADY ANSWERED');
    vi.setSystemTime(DAY_ONE + 90 * MIN);
    expect(textOf(renderRecallLane(ctx))).toBe(before);
  });

  it('CONTROL — when a row DOES change, every one of them changes', () => {
    seedReceipt('the invoice is attached', 'Dave', DAY_ONE - 30 * MIN);
    seedDelivery('what is your Delta number?', DAY_ONE - 35 * MIN);
    seedWork('ask:t69b1', 'ask', 'send the roof quote to Bob', DAY_ONE - 50 * MIN);
    seedAnsweredPair('what is the boat insurance number', 'It is 44-291.', DAY_ONE - 40 * MIN);

    const outbound = renderRecentOutboundBlock(getRecentOutbound(AGENT, 24, 5));
    const deliveries = textOf(renderDeliveriesLane(deliveriesCtx()));
    const openWork = buildOpenWorkInjection(AGENT, CONV);
    const answered = renderRecentlyAnsweredBlock(recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT));

    // The clock moves too, so this is not "the clock froze": the SOURCE moved as well.
    vi.setSystemTime(DAY_ONE + 5 * MIN);
    seedReceipt('one more thing', 'Dave', DAY_ONE + 4 * MIN);
    seedDelivery('and your seat preference?', DAY_ONE + 4 * MIN);
    seedWork('ask:t69b3', 'ask', 'book the flight', DAY_ONE + 4 * MIN);
    seedAnsweredPair('and the excess', 'Five hundred.', DAY_ONE + 4 * MIN);

    expect(renderRecentOutboundBlock(getRecentOutbound(AGENT, 24, 5))).not.toBe(outbound);
    expect(textOf(renderDeliveriesLane(deliveriesCtx()))).not.toBe(deliveries);
    expect(buildOpenWorkInjection(AGENT, CONV)).not.toBe(openWork);
    expect(renderRecentlyAnsweredBlock(recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT)))
      .not.toBe(answered);
  });

  it('a row whose timestamp will not parse still renders a STABLE term, not a clock reading', () => {
    // The degraded path was `relativeTimeAgo`'s `'recently'`. It must not become "now".
    seedDelivery('a row with a broken stamp', DAY_ONE - 20 * MIN);
    mockDb.current!.prepare("UPDATE deliveries SET created_at = 'not-a-time'").run();
    const before = textOf(renderDeliveriesLane(deliveriesCtx()));
    vi.setSystemTime(DAY_ONE + 90 * MIN);
    expect(textOf(renderDeliveriesLane(deliveriesCtx()))).toBe(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 THE SAME SET IS THE SAME BYTES. Presentation order may not encode a similarity ranking.
//
// The recall lane's own header already ruled this for the RAW lines — "similarity ordering
// once put a stale statement of a since-corrected fact FIRST and the weakest floor model
// echoed it" — and sorted them chronologically. The vault lines and the answered pairs were
// left in rank order, so the SAME rows retrieved with a nudged ranking (which is what a
// different ask produces) rendered different bytes with nothing having changed. RED at
// `2557747`, and observed on the dev box: turn 2 -> 3, three vault lines, two of them merely
// swapped.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T69b §2 — the same rows in a different RANK render the same bytes', () => {
  const VAULT = [
    { id: 'v-c', type: 'fact', content: 'The garage keypad code is 8841.' },
    { id: 'v-a', type: 'decision', content: 'Pick: Squarespace Core, about $276 a year.' },
    { id: 'v-b', type: 'fact', content: 'The north gym locker code is GYM-O1VNAD-DC2.' },
  ];

  it('the vault lines are order-invariant over the hit ranking', () => {
    const forward = textOf(renderRecallLane(recallCtx({ vaultHits: VAULT })));
    const reversed = textOf(renderRecallLane(recallCtx({ vaultHits: [...VAULT].reverse() })));
    const rotated = textOf(renderRecallLane(recallCtx({ vaultHits: [VAULT[1], VAULT[2], VAULT[0]] })));
    expect(reversed).toBe(forward);
    expect(rotated).toBe(forward);
    // and every row is still there — order-invariance must not be achieved by dropping rows
    for (const e of VAULT) expect(forward).toContain(e.content);
  });

  it('the answered pairs are order-invariant over the hit ranking, and read OLDEST first', () => {
    const older = seedAnsweredPair('the older question', 'the older conclusion', DAY_ONE - 6 * HOUR);
    const newer = seedAnsweredPair('the newer question', 'the newer conclusion', DAY_ONE - 1 * HOUR);

    const forward = textOf(renderRecallLane(recallCtx({
      msgHits: [{ sourceId: older.askId }, { sourceId: newer.askId }],
    })));
    const reversed = textOf(renderRecallLane(recallCtx({
      msgHits: [{ sourceId: newer.askId }, { sourceId: older.askId }],
    })));
    expect(reversed).toBe(forward);

    // The lane's own sentence: "Oldest pair first, so the newest conclusion sits in the
    // recency-salient position." It reversed the SIMILARITY order until T69b, which made the
    // sentence false whenever the ranking did not happen to be chronological.
    expect(forward.indexOf('the older conclusion')).toBeLessThan(forward.indexOf('the newer conclusion'));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 ONE BLOCK, ONE SOURCE. The HL5 board snapshot leaves the per-ask message and goes FIRST.
//
// RED at `2557747` by construction: `renderPayload` returned ONE string, `[recalled,
// snapshot].join('\n\n')`. A provider's prefix cache breaks at the first differing token and
// never recovers, so a per-ask retrieval in front of ~1,400 chars of board state re-billed the
// board state on every single ask — measured on the dev box on three consecutive quiet turns.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T69b §3 — the board snapshot is its own block, ahead of everything per-ask', () => {
  beforeEach(() => {
    seedWork('cmt:t69bx', 'commitment', 'Send Kevin the invoice', DAY_ONE - 2 * HOUR);
  });

  it('renders as TWO messages, snapshot FIRST', () => {
    const render = renderRecallLane(recallCtx({
      vaultHits: [{ id: 'v-1', type: 'fact', content: 'The garage keypad code is 8841.' }],
    }));
    expect(render!.messages).toHaveLength(2);
    expect(render!.messages[0].content as string).toContain('OPEN COMMITMENTS');
    expect(render!.messages[1].content as string).toContain('RELEVANT MEMORY');
    // and the snapshot is not ALSO inside the retrieved half
    expect(render!.messages[1].content as string).not.toContain('OPEN COMMITMENTS');
  });

  it('the snapshot is byte-identical while the per-ask half changes underneath it', () => {
    const ask1 = renderRecallLane(recallCtx({
      vaultHits: [{ id: 'v-1', type: 'fact', content: 'The garage keypad code is 8841.' }],
    }))!;
    const ask2 = renderRecallLane(recallCtx({
      vaultHits: [{ id: 'v-9', type: 'fact', content: 'Something else entirely.' }],
    }))!;

    expect(ask2.messages[0].content).toBe(ask1.messages[0].content); // the board did not move
    expect(ask2.messages[1].content).not.toBe(ask1.messages[1].content); // the ask did
  });

  it('an ask OPENED AND CLOSED inside the turn does not move the snapshot', () => {
    // The measured one. Serving a turn writes an ask row and closes it in the same turn, so
    // `boardLastChangedAt` scoped to EVERY work row advanced on every single turn — and on the
    // dev box at `7c95ab5` the `as of` MINUTE was the only byte that differed in the whole
    // 995-char block. The block reports open commitments and open-row counts; a row that is
    // neither open nor a commitment when it is read appears in nothing it prints.
    const before = renderCommitmentsBlock(renderRecallLane(recallCtx())!.payload!);
    vi.setSystemTime(DAY_ONE + 3 * MIN);
    seedWork('ask:transient', 'ask', 'the turn\'s own ask', DAY_ONE + 2 * MIN, {
      updated_at: DAY_ONE + 2 * MIN + 500, closed_at: DAY_ONE + 2 * MIN + 900,
      // `state='done'` needs a delivery id (the schema's own CHECK); `abandoned` is the
      // terminal state a settled probe ask actually reaches and needs none.
      state: 'abandoned',
    });
    expect(renderCommitmentsBlock(renderRecallLane(recallCtx())!.payload!)).toBe(before);
  });

  it('CONTROL — a board change DOES move the snapshot, opened AND closed', () => {
    const before = renderCommitmentsBlock(renderRecallLane(recallCtx())!.payload!);
    vi.setSystemTime(DAY_ONE + 5 * MIN);
    seedWork('cmt:t69by', 'commitment', 'Post the parcel', DAY_ONE + 4 * MIN);
    const opened = renderCommitmentsBlock(renderRecallLane(recallCtx())!.payload!);
    expect(opened).not.toBe(before);
    expect(opened).toContain('Post the parcel');

    // and CLOSING a commitment moves it too — that is the event the superseding sentence is
    // for, and it is why the scope is not simply "rows that are open now".
    vi.setSystemTime(DAY_ONE + 9 * MIN);
    mockDb.current!.prepare(
      "UPDATE work SET closed_at = ?, updated_at = ?, state = 'abandoned' WHERE id = 'cmt:t69by'",
    ).run(DAY_ONE + 8 * MIN, DAY_ONE + 8 * MIN);
    const closed = renderCommitmentsBlock(renderRecallLane(recallCtx())!.payload!);
    expect(closed).not.toBe(opened);
    expect(closed).not.toContain('Post the parcel');
  });

  it('an agent with nothing on its board still publishes no snapshot, and the lane is ONE message', () => {
    mockDb.current!.prepare('DELETE FROM work').run();
    const render = renderRecallLane(recallCtx({
      vaultHits: [{ id: 'v-1', type: 'fact', content: 'The garage keypad code is 8841.' }],
    }))!;
    expect(render.messages).toHaveLength(1);
    expect(renderCommitmentsBlock(render.payload!)).toBeNull();
    expect(renderRecalledBlock(render.payload!)).toContain('RELEVANT MEMORY');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 THE ORDER IS THE CONTRACT — most-stable-first, the three deliberate lanes LAST.
//
// This is the clause that makes the classification enforceable rather than merely written
// down. It reads the injection order OUT of `pre-call-injections.ts` — the file that decides
// it — rather than restating it, so a future reordering fails HERE with the reason attached.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T69b §4 — the tail is ordered most-stable-first and the deliberate lanes sit last', () => {
  /**
   * The lanes whose churn is REGISTERED as deliberate, and the reason each is granted. They
   * are the LAST FOUR messages of the tail, in this order, so what each costs is itself.
   *
   * `engine.recently-answered` earns its place by MEASUREMENT, not by assumption: after the
   * order fix the dev box showed it still moving on every judged pair, and the diff says why —
   * a new answer stamp enters the top-three and the oldest falls out. Its source is "the last
   * three answered asks of THIS conversation", and a conversational turn answers one. That is
   * per-turn material by construction, the same class as the directive pin; what T69b removed
   * from it was the WALL-CLOCK read on top of that (§1) and its position in FRONT of every
   * block that changes rarely (below).
   */
  const DELIBERATE: ReadonlyArray<readonly [string, string]> = [
    ['engine.recently-answered', 'its source IS the last three answered asks of THIS conversation, and a conversational turn answers one — per-turn material by construction, not a clock read'],
    ['msg.relevant-memory', 'retrieved against the LIVE ASK — roadmap #10 is why it rides the tail'],
    ['msg.directive', 'its content IS the newest unanswered ask (T67b §7)'],
    ['msg.current-time', 'its content IS the clock'],
  ];

  /**
   * The injection order, read from the ENGINE FILE that decides it — located through the
   * shared derivation (`engine-sources.ts`), never by a hand-typed path. GUARD-AUDIT's census
   * requires this: a guard that names `agent/v2/steps/...` by path stops seeing its subject
   * SILENTLY the next time a tranche moves it, and `engineFileWithBoth` throws with both homes
   * printed if the two ends of the order ever land in different files.
   */
  const injectionOrder = (): string[] => {
    const src = engineFileWithBoth("'engine.open-commitments'", "'msg.current-time'");
    const ids: string[] = [];
    for (const m of src.text.matchAll(
      /(?:injectRegistryMessage|pushEngineMessage)\([^)]*?['"]((?:msg|engine)\.[a-z-]+)['"]/gs,
    )) {
      if (!ids.includes(m[1])) ids.push(m[1]);
    }
    return ids;
  };

  it('the deliberate lanes are the LAST ones, in that order', () => {
    const order = injectionOrder();
    expect(order.slice(-DELIBERATE.length)).toEqual(DELIBERATE.map(([id]) => id));
  });

  it('every block that changes every turn sits BEHIND every block that changes rarely', () => {
    const order = injectionOrder();
    const at = (id: string) => {
      const i = order.indexOf(id);
      expect(i, `${id} is not injected by pre-call-injections.ts`).toBeGreaterThanOrEqual(0);
      return i;
    };
    // The board snapshot moves when the WORK BOARD moves; the answered ledger moves on every
    // answered turn; the recall lane moves on every ask. That is the required order, and both
    // of the first two were on the wrong side of it at `2557747`.
    expect(at('engine.open-commitments')).toBeLessThan(at('engine.recently-answered'));
    expect(at('engine.recently-answered')).toBeLessThan(at('msg.relevant-memory'));
    // The send-keyed blocks are stabler than all three and stay in front of them.
    expect(at('engine.recent-outbound')).toBeLessThan(at('engine.open-commitments'));
    expect(at('msg.deliveries')).toBeLessThan(at('engine.open-commitments'));
    expect(at('engine.open-work')).toBeLessThan(at('engine.open-commitments'));
  });

  it('every injected tail entry is DECLARED in the lane table — no undeclared block rides here', () => {
    for (const id of injectionOrder()) {
      expect(POST_BUDGET_ENTRY_LANE[id], `${id} rides the tail undeclared`).toBeTruthy();
    }
  });

  it('the slot numbers say the same thing the imperative order does', () => {
    expect(MessageSlot.TurnContext).toBeLessThan(MessageSlot.Deliveries);
    expect(MessageSlot.Deliveries).toBeLessThan(MessageSlot.PeerStatus);
    expect(MessageSlot.PeerStatus).toBeLessThan(MessageSlot.RecalledMemory);
    expect(MessageSlot.RecalledMemory).toBeLessThan(MessageSlot.ActiveDirectiveTail);
    expect(MessageSlot.ActiveDirectiveTail).toBeLessThan(MessageSlot.CurrentTime);
  });

  it('the deliberate list is a REGISTRY, not a habit — each entry states why it is exempt', () => {
    for (const [id, why] of DELIBERATE) {
      expect(why.length, `${id} is exempt with no reason recorded`).toBeGreaterThan(20);
    }
    expect(DELIBERATE).toHaveLength(4);
  });
});
