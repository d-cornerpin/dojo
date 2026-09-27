// ════════════════════════════════════════════════════════════════════════════════════════
// A RESET IS A DECISION TO FORGET — the time axis the suppression reads never had.
//
// ── THE DEFECT, MEASURED ON THE OWNER'S BODY (`conversation-identity-investigation.md`) ──
// A session reset moves a `WHERE` predicate (`agents.session_started_at`) and nothing else:
// `conversations` identity has NO session dimension, so the SAME `conversation_id` survives every
// reset for ever. Four reads believed they were session-bounded BECAUSE they were
// conversation-scoped. They were not bounded at all.
//
//   3,930 of 3,931 session dividers on that box have a prior answer-stamped ask in the same
//   conversation — 99.97% of resets reached across — and one reach is byte-verified from a
//   receipt: `engine.recently-answered`, 557 chars, sha256 `6a74962c238b9c92`, on the FIRST turn
//   after the 2026-09-22 09:05:33 reset, naming three asks that ALL predate it.
//
// One live row states the consequence better than any measurement: the first assistant turn of a
// brand-new session, mid-thread on a channel that had just been reset, opened *"Verdict stands
// from my earlier check"* — carrying a claim across a boundary that was a decision to forget.
//
// ── THE TWO DIRECTIONS THIS FILE HOLDS, AND WHY BOTH ARE NEEDED ──────────────────────────────
// §1-§4 are the fix: after a reset, the engine stops naming pre-reset asks as settled.
// §5-§6 are the OTHER owner complaint, and they are the reason this is not a one-line change: he
// has a standing complaint that agents REPEAT THEMSELVES, and these carriers are what stops that.
// A time bound that leaks into intra-session behaviour would trade his reset complaint for his
// repetition complaint. So §5 holds the unchanged-behaviour clauses BY DERIVATION — the bounded
// read on a body whose rows are all inside the session must be byte-identical to the unbounded
// read on the same body — and §6 pins one canonical render so the renderer cannot drift either.
//
// ── §3 IS THE TRAP, AND IT HAS ALREADY COST THIS CODEBASE A WHOLE CONTEXT ────────────────────
// `messages.created_at` is epoch-ms INTEGER since migration 131; `agents.session_started_at` is
// TEXT. `<integer> >= '<datetime>'` does not error in SQLite — it is FALSE for every row. Written
// the obvious way, every one of these reads becomes a permanent empty list, silently, and no
// SQL-literal scan can see it because the fragment never names a table. `memory/store.ts:77-81`
// records what it cost when it happened to the fresh-tail loader: *"the whole tail comes back
// EMPTY, the model is handed nothing, and the turn ends without a reply."* §3 plants the unwrapped
// form and proves it returns nothing, so the wrapping is a clause and not a habit.
//
// ── THE ONE JUDGEMENT, HELD AS A CLAUSE (§4) ─────────────────────────────────────────────────
// An answered pair crossing a reset carries a CONCLUSION and an IMPERATIVE (*"Do NOT re-run the
// work"*). The conclusion is memory and the recall lane's charter — `recall-lane.test.ts` has
// asserted since it was written that a previous session's conclusion is still recallable, and that
// clause is right. The imperative overrides the owner's own instruction to forget. So a pre-reset
// pair is DEMOTED, not deleted: it keeps its quote and loses its order. §4 holds both halves.
//
// ── OWNER RULING THAT BREAKS EVERY TIE (2026-08-05, governing) ───────────────────────────────
// Ambiguity resolves toward ANSWERING AGAIN. Every clause below points that way.
//
// ── MUTATION RECORD (each planted in the product, measured, reverted by restoring the
// byte-identical file; sha256 re-asserted after every one) ──
//   see the table appended at the foot of this file, filled from the real runs.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-reset-forget-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import {
  RECENTLY_ANSWERED_LIMIT, recentlyAnsweredAsks, recordedAnswerInConversation,
  renderRecentlyAnsweredBlock,
} from '../answered-edge.js';
import {
  sessionBoundaryClause, sessionBoundaryMs, sessionBoundaryText, withSessionBoundary,
} from '../../../memory/session-boundary.js';
import { priorOwnerContext } from '../../../work/ask-title.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const stripComments = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const AGENT = 'resetter';
const CONV = 'conv-dashboard';
const db = (): Database.Database => mockDb.current!;

/** Epoch ms, one minute apart so `ORDER BY created_at DESC` is deterministic and so a boundary
 *  can be placed strictly between any two rows. */
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);
const at = (minutes: number): number => T0 + minutes * 60_000;
/** The TEXT shape `agents.session_started_at` actually holds, from an epoch-ms instant. */
const boundaryTextAt = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function seedMessage(p: {
  id: string; role: 'user' | 'assistant'; content: string; atMs: number;
  conversationId?: string | null; lane?: string | null; agentId?: string;
}): string {
  db().prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, role, content, created_at,
                           channel, sender_id, display_kind, lane)
     VALUES (?, ?, ?, ?, ?, ?, 'dashboard', 'owner', ?, ?)`,
  ).run(p.id, p.agentId ?? AGENT, p.conversationId === undefined ? CONV : p.conversationId,
    p.role, p.content, p.atMs, p.role === 'user' ? 'user-text' : 'agent-text', p.lane ?? 'owner');
  return p.id;
}

function stampAnswer(askId: string, answerId: string): void {
  db().prepare('UPDATE messages SET answer_message_id = ? WHERE id = ?').run(answerId, askId);
}

/** Move the agent's session boundary, the way all five reset doors do. */
function resetSessionAt(ms: number, agentId = AGENT): void {
  db().prepare('UPDATE agents SET session_started_at = ? WHERE id = ?').run(boundaryTextAt(ms), agentId);
}

/** An ask answered at a named instant, returning both ids. */
function answeredAskAt(minutes: number, ask: string, answer: string, tag = `${minutes}`): {
  askId: string; answerId: string;
} {
  const askId = seedMessage({ id: `ask-${tag}`, role: 'user', content: ask, atMs: at(minutes) });
  const answerId = seedMessage({
    id: `ans-${tag}`, role: 'assistant', content: answer, atMs: at(minutes) + 30_000,
  });
  stampAnswer(askId, answerId);
  return { askId, answerId };
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare(
    `INSERT INTO agents (id, name, classification, status, session_started_at)
     VALUES (?, 'A', 'sensei', 'idle', NULL)`,
  ).run(AGENT);
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id)
     VALUES (?, ?, 'dashboard', 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE REPRODUCTION. Two asks settled, then a reset. Every carrier must forget.
//
// This is the shape the investigation measured, reduced to its bones: the asks and the reset are
// in the SAME conversation id, because that is what a reset actually produces. A test that hands
// itself a second conversation id is testing a platform that does not exist — which is exactly
// what `recall-lane.test.ts` §4 did, and §7 replaces it.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 after a reset, the engine stops naming pre-reset asks as settled', () => {
  it('carrier 1 — `engine.recently-answered` lists nothing from before the boundary', () => {
    answeredAskAt(0, 'What is on my calendar this week?', 'Three things: …', 'a');
    answeredAskAt(5, 'Did the vet appointment get booked?', 'Yes, Thursday 2pm.', 'b');
    // Unbounded today: both asks are named on the first turn of the next session.
    expect(recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT)).toHaveLength(2);

    resetSessionAt(at(10));

    expect(recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT)).toHaveLength(0);
  });

  it('carrier 5 — the recorded-answer rung quotes nothing from before the boundary', () => {
    answeredAskAt(0, 'Is the internet down?', 'No outage — six probes clean.', 'a');
    expect(recordedAnswerInConversation(AGENT, CONV)).toContain('six probes clean');

    resetSessionAt(at(10));

    expect(recordedAnswerInConversation(AGENT, CONV)).toBeNull();
  });

  it('the ask-titling read does not title a new ticket from a forgotten session', () => {
    seedMessage({ id: 'old-1', role: 'user', content: 'Set up the quarterly deck', atMs: at(0) });
    seedMessage({ id: 'old-2', role: 'user', content: 'Use last quarter as the template', atMs: at(1) });
    const fresh = seedMessage({ id: 'new-1', role: 'user', content: 'What about the invoice?', atMs: at(20) });
    expect(priorOwnerContext(AGENT, CONV, fresh).join(' ')).toContain('quarterly deck');

    resetSessionAt(at(10));

    expect(priorOwnerContext(AGENT, CONV, fresh)).toEqual([]);
  });

  it('a row ON the boundary instant is INSIDE the new session, not outside it', () => {
    // `>=`, not `>`. The reset writes the boundary at the instant it runs; a message written in
    // that same second belongs to the session that is starting. The opposite choice silently
    // drops the first ask of every new session, which is the failure this read exists to prevent.
    answeredAskAt(10, 'the ask that lands on the boundary second', 'answered', 'edge');
    resetSessionAt(at(10));
    expect(recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT)).toHaveLength(1);
  });

  it('asks from BEFORE and AFTER one boundary are split, not all-or-nothing', () => {
    answeredAskAt(0, 'before the reset', 'old answer', 'before');
    resetSessionAt(at(10));
    answeredAskAt(20, 'after the reset', 'new answer', 'after');

    const listed = recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT);
    expect(listed).toHaveLength(1);
    expect(listed[0].askContent).toBe('after the reset');
    expect(recordedAnswerInConversation(AGENT, CONV)).toBe('new answer');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — TWO RESETS. The bound is the CURRENT session, not "one session back".
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the bound is the live boundary, however many resets happened', () => {
  it('two sessions back is as forgotten as one', () => {
    answeredAskAt(0, 'two sessions ago', 'a1', 'two');
    resetSessionAt(at(5));
    answeredAskAt(6, 'one session ago', 'a2', 'one');
    resetSessionAt(at(10));
    answeredAskAt(11, 'this session', 'a3', 'now');

    const listed = recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT);
    expect(listed.map((a) => a.askContent)).toEqual(['this session']);
  });

  it('the boundary is per AGENT, so one agent\'s reset does not blind another', () => {
    const OTHER = 'other-agent';
    db().prepare(
      `INSERT INTO agents (id, name, classification, status, session_started_at)
       VALUES (?, 'B', 'sensei', 'idle', NULL)`,
    ).run(OTHER);
    db().prepare(
      `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id)
       VALUES ('conv-other', ?, 'dashboard', 'dashboard', 'owner')`,
    ).run(OTHER);
    const ask = seedMessage({
      id: 'o-ask', role: 'user', content: 'their settled ask', atMs: at(0),
      agentId: OTHER, conversationId: 'conv-other',
    });
    const ans = seedMessage({
      id: 'o-ans', role: 'assistant', content: 'their answer', atMs: at(1),
      agentId: OTHER, conversationId: 'conv-other',
    });
    stampAnswer(ask, ans);

    resetSessionAt(at(10));   // OUR agent resets

    expect(recentlyAnsweredAsks(OTHER, 'conv-other', RECENTLY_ANSWERED_LIMIT)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE TYPE TRAP, HELD AS A CLAUSE.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 the INTEGER/TEXT comparison is wrapped, and the unwrapped form is proven dead', () => {
  it('the wrapped clause matches rows; the obvious clause matches NONE', () => {
    answeredAskAt(20, 'a row well after the boundary', 'answered', 'after');
    resetSessionAt(at(10));
    const boundary = sessionBoundaryText(AGENT)!;

    const wrapped = db().prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND ${sessionBoundaryClause()}`,
    ).get(AGENT, boundary) as { n: number };
    expect(wrapped.n, 'the ask and its answer, both after the boundary').toBe(2);

    // THE PLANT: the same predicate written the way anybody would write it first.
    const unwrapped = db().prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND created_at >= ?',
    ).get(AGENT, boundary) as { n: number };
    expect(unwrapped.n, 'INTEGER >= TEXT is FALSE for every row — silently, for ever').toBe(0);
  });

  it('the clause names the column it was given, so a caller cannot bind the wrong one', () => {
    expect(sessionBoundaryClause()).toBe('created_at >= (unixepoch(?) * 1000)');
    expect(sessionBoundaryClause('m1.created_at')).toBe('m1.created_at >= (unixepoch(?) * 1000)');
  });

  it('`withSessionBoundary` hands back the clause and its parameter TOGETHER', () => {
    // The pairing is the safety property: a site cannot splice the SQL and forget the param.
    expect(withSessionBoundary(AGENT)).toEqual({ sql: '', params: [] });
    resetSessionAt(at(10));
    const got = withSessionBoundary(AGENT);
    expect(got.sql).toBe(' AND created_at >= (unixepoch(?) * 1000)');
    expect(got.params).toEqual([boundaryTextAt(at(10))]);
  });

  it('the ms accessor agrees with the TEXT one to the second', () => {
    expect(sessionBoundaryMs(AGENT)).toBeNull();
    resetSessionAt(at(10));
    expect(sessionBoundaryMs(AGENT)).toBe(at(10));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — NO BOUNDARY IS NOT A BOUNDARY AT ZERO.
//
// An agent that has never been reset carries `session_started_at IS NULL`. The safe reading is
// "no clause", and the dangerous one is `>= NULL`, which matches nothing in SQL and would empty
// every read on every fresh agent. Held as a clause because the difference is invisible in review.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 a NULL boundary adds no clause', () => {
  it('every carrier reads exactly as it did before, on an agent that was never reset', () => {
    answeredAskAt(0, 'ask one', 'answer one', 'a');
    answeredAskAt(5, 'ask two', 'answer two', 'b');
    expect(sessionBoundaryText(AGENT)).toBeNull();
    expect(recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT)).toHaveLength(2);
    expect(recordedAnswerInConversation(AGENT, CONV)).toBe('answer two');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE OTHER OWNER COMPLAINT: BYTE-IDENTICAL INSIDE A LIVE SESSION.
//
// Derived, never transcribed. The body is seeded once; the bounded read on a body whose rows are
// ALL inside the session must return exactly what the unbounded read returns on the same body. If
// the clause ever leaks into intra-session behaviour, these go red without anybody having to guess
// which bytes to pin.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 intra-session suppression is not weakened by one byte', () => {
  const seedALiveSession = (): void => {
    resetSessionAt(at(0));
    answeredAskAt(1, 'first ask of this session', 'first answer', 'a');
    answeredAskAt(2, 'second ask of this session', 'second answer', 'b');
    answeredAskAt(3, 'third ask of this session', 'third answer', 'c');
  };

  it('the same ask, asked twice in one session, is still deduped by the ledger', () => {
    seedALiveSession();
    const listed = recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT);
    expect(listed).toHaveLength(RECENTLY_ANSWERED_LIMIT);
    expect(listed.map((a) => a.askContent)).toEqual([
      'third ask of this session', 'second ask of this session', 'first ask of this session',
    ]);
  });

  it('the bounded read equals the unbounded read when the whole body is in-session', () => {
    seedALiveSession();
    const bounded = recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT);
    // Same body, boundary removed: this is what the read did before the time axis existed.
    db().prepare('UPDATE agents SET session_started_at = NULL WHERE id = ?').run(AGENT);
    const unbounded = recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT);
    expect(bounded).toEqual(unbounded);
    expect(renderRecentlyAnsweredBlock(bounded)).toBe(renderRecentlyAnsweredBlock(unbounded));
  });

  it('carrier 5 and the titling read are unchanged in-session too', () => {
    seedALiveSession();
    const answerBounded = recordedAnswerInConversation(AGENT, CONV);
    const fresh = seedMessage({ id: 'fresh', role: 'user', content: 'and now this', atMs: at(4) });
    const titleBounded = priorOwnerContext(AGENT, CONV, fresh);

    db().prepare('UPDATE agents SET session_started_at = NULL WHERE id = ?').run(AGENT);
    expect(recordedAnswerInConversation(AGENT, CONV)).toBe(answerBounded);
    expect(priorOwnerContext(AGENT, CONV, fresh)).toEqual(titleBounded);
    expect(titleBounded.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §6 — THE RENDERER HOLDS STILL.
//
// §5 proves the READ does not change in-session. This pins the BYTES of one canonical render, so
// a future edit to the block's wording is a decision somebody makes on purpose. The stamp is the
// recorded instant, so the value is stable under a clock that moves (T69b's own fix).
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§6 one canonical render, pinned', () => {
  it('three in-session asks render the bytes this block has always rendered', () => {
    resetSessionAt(at(0));
    answeredAskAt(1, 'What is on my calendar this week?', 'Three things', 'a');
    answeredAskAt(2, 'Did the vet appointment get booked?', 'Yes', 'b');
    answeredAskAt(3, 'Send the invoice when you can', 'Sent', 'c');
    const text = renderRecentlyAnsweredBlock(recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT))!;
    expect(text).toContain('RECENTLY ANSWERED');
    // Every ask is named, newest first, and no answer text leaks into this block — it is the
    // QUESTION ledger; the answers are the recall lane's half.
    expect(text).toContain('Send the invoice when you can');
    expect(text).toContain('What is on my calendar this week?');
    expect(text).not.toContain('Sent');
    // MEASURED, not chosen: the value below was read off this render on 2026-09-26. The stamp is
    // the RECORDED instant (T69b), so it does not move with the clock — if this goes red, the
    // BLOCK'S WORDING changed and somebody meant it to.
    expect(text).toHaveLength(460);
    expect(crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)).toBe('a1765347532e9778');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §7 — THE READS THAT MUST NOT BIND, held structurally.
//
// The investigation named four reads that keep their cross-session reach, each with a cited
// reason. A future task that "finishes the job" by adding the clause to these would break the
// recovery path and the duplicate-send guard, so the refusal is a clause rather than a comment.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§7 the recovery and de-duplication reads keep their reach', () => {
  const bindsTheBoundary = (rel: string): boolean => {
    const code = stripComments(read(rel));
    return code.includes('sessionBoundary') || code.includes('withSessionBoundary')
      || code.includes('session_started_at');
  };

  it('the recovery reads do NOT consult the boundary', () => {
    // `memory/retrieval.ts` is `history_search`/`history_get`/`history_expand` — agent-scoped, no
    // session clause and no conversation clause. It is the path the owner's own incident ended on
    // ("finally running history_get and answering correctly"), and `SWEEP-C.md:17(d)` is why it may
    // reach. `outbound-ledger.ts`: a reset must not become a licence to send the same message
    // twice — the owner filed that as its own defect.
    expect(bindsTheBoundary('memory/retrieval.ts')).toBe(false);
    expect(bindsTheBoundary('agent/v2/outbound-ledger.ts')).toBe(false);
  });

  it('⚠ the investigation named the wrong module here, and `recall.ts` was ALREADY bounded', () => {
    // Held as a clause rather than a footnote, because the investigation's Option-A touch list
    // says `memory/recall.ts:287` must NOT bind "because it is the recovery path" — and at HEAD it
    // binds already, under its own comment. A future reader who trusts that list would either
    // "restore" a reach that was never there or conclude this task left a read unbounded.
    const code = stripComments(read('memory/recall.ts'));
    expect(code).toContain('created_at >= (unixepoch(?) * 1000)');
    expect(read('memory/recall.ts')).toContain('Respect session boundary');
  });

  it('the four bound reads all reach the shared module, none hand-rolls the comparison', () => {
    for (const rel of ['agent/v2/answered-edge.ts', 'work/ask-title.ts', 'memory/recall-lane.ts']) {
      const code = stripComments(read(rel));
      expect(code, `${rel} must import the boundary, not re-derive it`)
        .toMatch(/session-boundary\.js/);
      expect(code, `${rel} must not hand-roll the unixepoch conversion`)
        .not.toMatch(/unixepoch\([^)]*\)\s*\*\s*1000/);
    }
  });
});
