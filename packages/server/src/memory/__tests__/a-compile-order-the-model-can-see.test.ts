// UX-REPAIR ROUND 2 / T10 — THE ONE NARROW EXEMPTION TO A2A TAIL SCOPING.
//
// ── THE DEFECT THIS PINS (investigation-round2.md §1, orchestrator-verified) ──
// The fan-out compile order is an ENGINE RIDER: a row that must be SEEN during a turn that is
// happening anyway, whose recorded delivery contract is "the deliverable's own wake carries it
// to the model" (`agent/a2a-transport.ts`, owner option B, 2026-07-18). But a delegated job's
// own wake IS an A2A turn, and `scopeToA2AThread` ends `return false; // exclude human + engine`
// — a `b2027b0` rule that predates the rider design by six weeks and was never reconciled with
// it. Measured on the box (S4, 2026-08-10): the compile order and redrives 1 and 2 were filtered
// out of turns 4553 and 4554 entirely; the answer came on turn 4555 only because that wake
// happened to be bare and therefore took the HUMAN scoper, which keeps engine rows.
//
// ── WHY THE EXEMPTION IS EXACTLY ONE INTENT AND NOT A CLASS ──
// `b2027b0`'s requirement is "one counterparty per turn; a second conversation never bleeds in".
// The compile order is not counterparty content at all: it is an imperative addressed to THIS
// agent, quoting THIS agent's OWN children's returned pieces. Nothing about it is another
// conversation. Every OTHER engine intent stays excluded, and the enumeration below is what
// makes that a gate rather than a sentence — a new rider intent is excluded by default and a
// future widening has to come here and argue.
//
// ════════════════════════════════════════════════════════════════════════════════════════
// ── T68b (2026-09-01) — THIS FILE'S TITLE WAS A CLAIM THE FILE DID NOT CHECK. ──────────
//
// Everything above tests `scopeToA2AThread` and NOTHING ELSE. It was green for three weeks
// while the order it names arrived at the model CUT IN HALF, and the half that survived was
// the half that promises the pieces and forbids looking for them.
//
// The chain (W61, verdict A, driven at two commits and byte-identical at both):
//   `a2a-transport.ts` files the order `lane='events'` → `shared/origin.ts` turns that into
//   `originKind='engine'` → the assembler's awareness partition pulls EVERY engine-origin
//   user row out of the fresh tail → `lane.events` renders one bullet per row, whitespace-
//   collapsed and sliced to `lim('lane.events','chars','gist')` = 400. 3,660 chars in,
//   400 out. The cut lands mid-word at "Do NOT search, op", BEFORE
//   "Here is each piece's delivered content, verbatim:" and before every piece.
//
// T10's carve-out at `assembler.ts` scopeToA2AThread kept the row in the SCOPED TAIL and was
// then nullified two hundred lines later by the awareness partition, which reclassified it.
// So §T68b below asserts on the ASSEMBLED CONTEXT — the bytes the model is handed — instead
// of on one filter three steps upstream of it. The cut string is the fingerprint: it can
// only appear if a gist produced it.
//
// Cost of the six recorded failures this closes: three full 16,384-token output budgets
// burned in twelve minutes on 2026-08-31, the model searching its own context for content
// the platform had removed while an engine instruction insisted it was there.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Message, MessageOrigin } from '@dojo/shared';

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

vi.mock('../../agent/model.js', () => ({
  callModel: async () => ({ content: 'x', toolCalls: [], usage: {} }),
  getContextWindow: () => CONTEXT_WINDOW,
  getModelOutputCap: () => 4096,
}));

vi.mock('../vector-search.js', () => ({
  vectorSearch: async () => [],
}));

import { assembleContext, compileOrderReachedTheModel, scopeToA2AThread } from '../assembler.js';
import { runMigrations } from '../../db/migrations.js';
import { ENGINE_RIDER_INTENTS } from '../../agent/v2/engine-riders.js';
import { COMPILE_ORDER_PIECES_MARKER, compileSteerText, JOIN_REDRIVE_BOUND } from '../../work/join-drive.js';

const THREAD = '1a952a39-1111-2222-3333-444444444444';
const OTHER_THREAD = '34430191-9999-8888-7777-666666666666';

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return {
    agentId: 'a1', tokenCount: null, modelId: null, cost: null, latencyMs: null,
    createdAt: '2026-08-10 06:17:10', ...partial,
  } as Message;
}

function engineOrigin(intent: string | null): MessageOrigin {
  return {
    kind: 'engine', relation: 'engine', channel: 'engine',
    senderName: null, senderId: null, threadId: null, intent, authorized: false,
  };
}

function agentOrigin(threadId: string): MessageOrigin {
  return {
    kind: 'agent', relation: 'agent', channel: 'a2a',
    senderName: 'Ticky', senderId: 'ticky', threadId, intent: 'ASSIGN', authorized: true,
  };
}

function humanOrigin(): MessageOrigin {
  return {
    kind: 'user', relation: 'owner', channel: 'dashboard',
    senderName: 'David', senderId: 'david', threadId: null, intent: null, authorized: true,
  };
}

const compileOrder = msg({
  id: 'steer-fanout', role: 'user', origin: engineOrigin('fanout_join'),
  content: 'All 2 delegated pieces for the owner\'s request are now back.',
});
const thisThreadPeer = msg({
  id: 'peer-here', role: 'user', origin: agentOrigin(THREAD), content: 'here is my piece',
});
const otherThreadPeer = msg({
  id: 'peer-elsewhere', role: 'user', origin: agentOrigin(OTHER_THREAD), content: 'a different job',
});
const ownerLine = msg({
  id: 'owner-line', role: 'user', origin: humanOrigin(), content: 'can you also book the flight?',
});

describe('T10: the compile order survives the A2A scoper', () => {
  it('an A2A turn keeps the fan-out compile order in its tail', () => {
    const kept = scopeToA2AThread([compileOrder, thisThreadPeer], THREAD).map((m) => m.id);
    expect(kept).toContain('steer-fanout');
  });

  it('the exemption does not re-open cross-conversation bleed: the owner and other threads stay out', () => {
    const kept = scopeToA2AThread(
      [compileOrder, thisThreadPeer, otherThreadPeer, ownerLine], THREAD,
    ).map((m) => m.id);
    expect(kept).toEqual(['steer-fanout', 'peer-here']);
  });
});

describe('T10 conformance: fanout_join is the ONLY engine intent an A2A tail keeps', () => {
  // The whole rider table, enumerated from its own module so a new intent cannot be added
  // without this gate seeing it.
  const EXEMPT = new Set(['fanout_join']);

  for (const intent of ENGINE_RIDER_INTENTS) {
    it(`origin_intent='${intent}' is ${EXEMPT.has(intent) ? 'KEPT (the one exemption)' : 'excluded'} from an A2A tail`, () => {
      const row = msg({ id: `row-${intent}`, role: 'user', origin: engineOrigin(intent), content: 'x' });
      const kept = scopeToA2AThread([row, thisThreadPeer], THREAD).map((m) => m.id);
      expect(kept.includes(`row-${intent}`)).toBe(EXEMPT.has(intent));
    });
  }

  it('an engine row with no intent at all stays excluded', () => {
    const row = msg({ id: 'row-bare', role: 'user', origin: engineOrigin(null), content: 'x' });
    expect(scopeToA2AThread([row, thisThreadPeer], THREAD).map((m) => m.id)).toEqual(['peer-here']);
  });

  it('an engine intent that is NOT a declared rider stays excluded', () => {
    const row = msg({ id: 'row-unknown', role: 'user', origin: engineOrigin('some_future_intent'), content: 'x' });
    expect(scopeToA2AThread([row, thisThreadPeer], THREAD).map((m) => m.id)).toEqual(['peer-here']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §T68b — THE ASSEMBLED CONTEXT. Everything above proves a filter; this proves the DELIVERY.
//
// The seed is the round-16 S5 shape as the store recorded it on 2026-08-31 (BehaviorBot,
// seqs 70594 / 70613 / 70633 / 70643): an owner ask that names two sub-jobs, Healer's
// deliverable and Ticky's deliverable as A2A inbounds on their OWN conversations, and one
// `lane='events'` / `origin_intent='fanout_join'` row whose body quotes both pieces verbatim.
// The turn is assembled with NO counterparty — the exact shape of turns 5121/5122, whose
// `turns.kind` is NULL and whose `conv_key` is NULL, so the human scoper runs unscoped.
// ════════════════════════════════════════════════════════════════════════════════════════

const AGENT = 'agent-t68b';
const MODEL = 'model-t68b';
const CONTEXT_WINDOW = 200000;
const T0 = Date.parse('2026-08-31T23:30:00Z');

/** Fingerprints. Each is a token the platform itself put in the bytes, so "did it arrive"
 *  is a substring test on the platform's own output, never a reading of prose. */
const ASK_FP = 'OWNER-ASK-FINGERPRINT-4f21';
const PIECE1_FP = 'PIECE-ONE-FINGERPRINT-9c07';
const PIECE2_FP = 'PIECE-TWO-FINGERPRINT-2b8d';
const NOTICE_FP = 'SCHEDULER-NOTICE-FINGERPRINT-7e33';

/** THE CUT ITSELF. `lane.events` slices the collapsed body at 400 chars, and on the compile
 *  order that lands mid-word inside "Do NOT search, open files". The negative lookahead is
 *  what makes it a fingerprint rather than a phrase: the whole order always contains
 *  "Do NOT search, open files", and ONLY a 400-char gist can contain "Do NOT search, op"
 *  with anything else after it. */
const GIST_CUT = /Do NOT search, op(?!en files)/;

const OWNER_ASK =
  `Have your helpers work out a weekend plan for my parents visiting: one finds a good casual `
  + `dinner spot near Green Lake with easy parking, the other builds a Saturday itinerary that `
  + `keeps the walking light. Give me both together when they are back. [${ASK_FP}]`;

const PIECE_1 =
  `**Duke's Seafood — Green Lake** 7850 Green Lake Dr N, Seattle. Casual chowder house, big `
  + `free lot behind the building plus street parking on Winona, no reservation needed before `
  + `6pm on a Saturday, and the patio side is the quiet one. [${PIECE1_FP}]`;
const PIECE_2 =
  `Saturday itinerary — Seattle, low-walking: 9am Ballard farmers market (flat, 3 blocks), `
  + `12pm lunch at the Locks cafe, 3pm Gas Works overlook from the parking level. [${PIECE2_FP}]`;

let tseq = 0;

function insertRow(p: {
  role: string; content: string; lane: 'owner' | 'a2a' | 'events';
  conversationId?: string | null; sourceAgentId?: string | null; originIntent?: string | null;
}): string {
  tseq += 1;
  const id = `t68b-${tseq}`;
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier,
                           turn_number, provenance, authorized, token_count, created_at,
                           conversation_id, source_agent_id, origin_intent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'live', 1, ?, ?, ?, ?, ?)`,
  ).run(
    id, AGENT, p.role, p.lane, p.lane === 'owner' ? 'owner' : null, p.content,
    p.lane === 'events' ? 'engine-note' : p.lane === 'a2a' ? 'a2a'
      : p.role === 'assistant' ? 'agent-text' : 'user-text',
    p.lane === 'owner' ? 'user-visible' : 'agent-only',
    Math.max(1, Math.ceil(p.content.length / 4)), T0 + tseq * 1000,
    p.conversationId ?? null, p.sourceAgentId ?? null, p.originIntent ?? null,
  );
  return id;
}

/** The compile order, generated by the SAME function the transport calls, so the test can
 *  never drift from the bytes the product writes. */
function compileOrderContent(): string {
  return compileSteerText({
    total: 2,
    pieces: [
      `Piece 1 (from Healer, thread 4483996a): "${PIECE_1}"`,
      `Piece 2 (from Ticky, thread 12bde069): "${PIECE_2}"`,
    ],
    attempt: 1,
    bound: JOIN_REDRIVE_BOUND,
  });
}

function seedTheS5Shape(): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://localhost:8000/v1')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled)
     VALUES (?, 'p', 'ds4-local', 'DS4', ?, 4096, '["tools","thinking"]', 1)`,
  ).run(MODEL, CONTEXT_WINDOW);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, ?, 'idle', ?, '{}')")
    .run(AGENT, 'T68b', MODEL);
  db.prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
     VALUES (?, 1, 'user', datetime('now'), NULL, NULL, 0)`,
  ).run(AGENT);

  insertRow({ role: 'user', content: OWNER_ASK, lane: 'owner', conversationId: 'conv-owner' });
  insertRow({ role: 'assistant', content: 'On it — splitting dinner and itinerary between two helpers.', lane: 'owner', conversationId: 'conv-owner' });
  insertRow({
    role: 'user', lane: 'a2a', conversationId: 'conv-healer', sourceAgentId: 'healer',
    content: `[A2A:ANSWER thread:4483996a from:Healer] ${PIECE_1}`,
  });
  insertRow({
    role: 'user', lane: 'a2a', conversationId: 'conv-ticky', sourceAgentId: 'ticky',
    content: `[A2A:DELIVERABLE thread:12bde069 from:Ticky] ${PIECE_2}`,
  });
}

const textOf = (msgs: Array<{ content: unknown }>): string =>
  msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

beforeEach(() => {
  tseq = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedTheS5Shape();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('T68b §1 — the compile order arrives WHOLE, in the assembled context', () => {
  it('RED: every quoted piece is in the bytes the model is handed', async () => {
    insertRow({ role: 'user', content: compileOrderContent(), lane: 'events', originIntent: 'fanout_join' });

    const text = textOf((await assembleContext(AGENT, MODEL)).messages);

    expect(text).toContain(PIECE1_FP);
    expect(text).toContain(PIECE2_FP);
    expect(text).toContain("Here is each piece's delivered content, verbatim:");
  });

  it('RED: the 400-char gist never produced this order — the cut string is absent', async () => {
    insertRow({ role: 'user', content: compileOrderContent(), lane: 'events', originIntent: 'fanout_join' });

    const text = textOf((await assembleContext(AGENT, MODEL)).messages);

    expect(text).not.toMatch(GIST_CUT);
    // The order arrives as ONE contiguous run of the platform's own bytes, not as a
    // reassembly the reader has to do: the row's whole content is a substring.
    expect(text).toContain(compileOrderContent());
  });

  it('RED: the redrive steer for a STUCK job arrives whole too (same lane, same cut)', async () => {
    // `steerAgentToTellOwnerStuck` (T48 rung N+1) rides the same `fanout_join` intent and is
    // ~600 chars, so the gist ate its last two sentences — including "Do NOT call any send
    // tool". Same class, same door, asserted so it cannot regress separately.
    const stuck =
      `The owner is still waiting on the request you delegated, and the platform has brought you `
      + `back to it 2 time(s) without a reply reaching them. 2 of 2 delegated piece(s) came back. `
      + `TELL THE OWNER NOW, in your own words, directly in this conversation: what you asked for, `
      + `what came back, and — plainly — that you have not finished it. If you can give them the `
      + `combined answer, give it. If you cannot, say so honestly rather than saying nothing. `
      + `Do NOT call any send tool; the engine routes your reply. [STUCK-STEER-FINGERPRINT-1a44]`;
    insertRow({ role: 'user', content: stuck, lane: 'events', originIntent: 'fanout_join' });

    const text = textOf((await assembleContext(AGENT, MODEL)).messages);
    expect(text).toContain('STUCK-STEER-FINGERPRINT-1a44');
  });
});

describe('T68b §2 — CONTROL: the awareness lane\'s charter is unchanged', () => {
  it('a non-compile engine notice is still gisted to 400 chars', async () => {
    const notice =
      `[Scheduler] the 6pm garbage reminder fired and was delivered. `
      + 'x'.repeat(420) + ` [${NOTICE_FP}]`;
    insertRow({ role: 'user', content: notice, lane: 'events', originIntent: 'scheduler' });

    const text = textOf((await assembleContext(AGENT, MODEL)).messages);

    expect(text).toContain('EVENTS & NOTICES');
    expect(text).toContain('the 6pm garbage reminder fired');
    // Past the 400-char cut, so it must NOT be there. If this ever goes green the exemption
    // stopped being one intent and became a class.
    expect(text).not.toContain(NOTICE_FP);
  });

  it('the compile order does not put a bullet in the EVENTS lane at all', async () => {
    insertRow({ role: 'user', content: compileOrderContent(), lane: 'events', originIntent: 'fanout_join' });

    const msgs = (await assembleContext(AGENT, MODEL)).messages;
    const events = msgs.filter((m) => typeof m.content === 'string' && m.content.includes('EVENTS & NOTICES'));

    // Nothing to gist ⇒ no lane. This is also the cache property: a compile order arriving
    // APPENDS a fresh-tail message and rewrites no block ahead of it (slot 1050 < 1100).
    expect(events).toHaveLength(0);
  });
});

describe('T68b §3 — the ACTIVE USER DIRECTIVE pins the ASK, never a helper\'s piece', () => {
  it('RED: with both deliverables in, the pin still holds the owner\'s ask', async () => {
    insertRow({ role: 'user', content: compileOrderContent(), lane: 'events', originIntent: 'fanout_join' });

    const pin = (await assembleContext(AGENT, MODEL)).directiveLane ?? '';

    expect(pin).toContain(ASK_FP);
    expect(pin).not.toContain(PIECE1_FP);
    expect(pin).not.toContain(PIECE2_FP);
  });

  it('RED: the pin does not OSCILLATE as recovery attempts land more pieces', async () => {
    // The loop W61 measured: each re-ask destroys the piece the previous one recovered, so
    // the agent can never hold both, so it can never compile, so the engine redrives.
    insertRow({ role: 'user', content: compileOrderContent(), lane: 'events', originIntent: 'fanout_join' });
    const first = (await assembleContext(AGENT, MODEL)).directiveLane ?? '';

    insertRow({
      role: 'user', lane: 'a2a', conversationId: 'conv-healer-2', sourceAgentId: 'healer',
      content: `[A2A:ANSWER thread:25c60ce3 from:Healer] ${PIECE_1}`,
    });
    const second = (await assembleContext(AGENT, MODEL)).directiveLane ?? '';

    insertRow({
      role: 'user', lane: 'a2a', conversationId: 'conv-ticky-2', sourceAgentId: 'ticky',
      content: `[A2A:ANSWER thread:18068b11 from:Ticky] ${PIECE_2}`,
    });
    const third = (await assembleContext(AGENT, MODEL)).directiveLane ?? '';

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first).toContain(ASK_FP);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §T68b §4 — THE VERDICT THE GATE IS ALLOWED TO SPEAK FROM.
//
// `refusal-gates.ts` refuses the model's lookups while a compile is owed and TELLS IT WHY:
// "the pieces are in the steer, quoted verbatim". W61 measured that false 6/6. The assembler
// is the only module that can answer the question, so it answers it here and the gate reads
// the answer (`state.compileOrderReachedModel` → `compileOwedGateDecision`).
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T68b §4 — the assembly VERIFIES the pieces before the gate asserts them', () => {
  it('the marker the checker looks for is the marker the steer writes', () => {
    // Writer and reader are one constant. If a future reword splits them, this goes red here
    // rather than going quiet in production, which is how the original sentence became a lie.
    expect(compileOrderContent()).toContain(COMPILE_ORDER_PIECES_MARKER);
  });

  it('an assembled turn carrying the whole order reports TRUE', async () => {
    insertRow({ role: 'user', content: compileOrderContent(), lane: 'events', originIntent: 'fanout_join' });
    expect((await assembleContext(AGENT, MODEL)).compileOrderIntact).toBe(true);
  });

  it('a turn with no compile order at all reports NULL — there is nothing to assert', async () => {
    expect((await assembleContext(AGENT, MODEL)).compileOrderIntact).toBeNull();
  });

  it('the ladder\'s OTHER fanout_join rungs are not compile orders and report NULL', async () => {
    // The stuck steer and the never-came-back notice ride the same intent and quote no pieces.
    // Neither can satisfy the gate's sentence, so neither may answer its question.
    insertRow({
      role: 'user', lane: 'events', originIntent: 'fanout_join',
      content: '[Engine] A piece of work you delegated never came back: the itinerary stream.',
    });
    expect((await assembleContext(AGENT, MODEL)).compileOrderIntact).toBeNull();
  });

  it('RED-BY-CONSTRUCTION: the 400-char gist, fed to the checker, reports FALSE', () => {
    // The exact bytes the awareness lane produced on 2026-08-31 — the order collapsed and
    // sliced at 400 chars, ending mid-word. This is the input the product can no longer build,
    // so it is driven straight at the predicate instead. If this ever reports true, the check
    // has stopped checking.
    const order = compileOrderContent();
    const gist = `• [Aug 31, 2026, 04:38 PM][fanout_join] ${order.replace(/\s+/g, ' ').trim().slice(0, 400)}`;
    const row = { origin: { kind: 'engine', intent: 'fanout_join' }, content: order } as never;

    expect(gist).toMatch(GIST_CUT);
    expect(gist).not.toContain(PIECE2_FP);
    expect(compileOrderReachedTheModel([row], [{ content: gist }])).toBe(false);
    expect(compileOrderReachedTheModel([row], [{ content: `[stamp] ${order}` }])).toBe(true);
  });
});
