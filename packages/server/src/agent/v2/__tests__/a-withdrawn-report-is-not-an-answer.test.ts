// ════════════════════════════════════════════════════════════════════════════════════════
// A WITHDRAWN REPORT IS NOT AN ANSWER — the v3.2.0 release ritual's round-2 RED.
//
// THE RED, measured on the dev box through real HTTP doors only (two independent arms, two
// clean scratch agents, an ordinary paraphrased re-ask and no byte-identical repetition):
//
//   ask for a bug report  ->  row reaches `awaiting_approval`, the ask gets its answer stamp
//   POST /api/reports/:id/cancel  ->  `cancelled`, 0 rows in `awaiting_approval`
//   POST /api/chat/:id/new-session, three ordinary asks, then a PARAPHRASED re-ask
//   ->  the model is handed `RECENTLY ANSWERED … do NOT re-execute this work` and a VERBATIM
//       quote of its own *"Written up and sitting on your dashboard as a preview card"*
//   ->  it never calls `dojo_report` again and tells the owner to press Post on a card that
//       does not exist. In the control arm it said the same thing in the SAME TURN as a tool
//       error stating the row was cancelled, and then ended the turn in silence.
//
// THE ROOT CAUSE is one layer below both blocks: `dojo_report` is the only user-facing door in
// the engine that writes no `deliveries` row (0 in the whole database, ever), so the "answered"
// stamp and the card it claims have NO EDGE between them and nothing can notice a withdrawal.
// `agent/v2/answered-edge.ts` owns every read on that path, so ONE predicate there
// (`answerStillStands`) is inherited by all five carriers rather than being re-derived at each.
//
// THE LAW: owner ruling 2026-08-05, the governing priority — ambiguity about whether the owner
// was answered resolves toward ANSWERING AGAIN, never toward silence or a quiet close. The
// direction `answerReceiptForAsk`'s docstring used to argue (owner transcript 2026-07-23, "erring
// toward answered can only ever SUPPRESS a second announcement") was overruled thirteen days
// later, and its premise is false here: the artefact is GONE.
//
// ── AND THE OTHER HALF OF THE BAR (§3) ──────────────────────────────────────────────────────
// The owner has a standing complaint that agents REPEAT THEMSELVES, and this machinery is what
// stops that (his 2026-08-09 incident: an agent re-investigating a question it had just
// answered). So suppression may not be weakened by one byte for anything BUT a withdrawn-report
// answer. §3 is that clause, and it is what the over-widening mutant fails.
//
// ── ROUND 3 · THE SECOND GENERATION, AND WHY THE BINDING CHANGED ────────────────────────────
// Rounds 1-2 bound `tool_use.input.report_id` — the id an agent PASSES BACK. Round 3's pre-flight
// check caught what that misses, on a clean agent, through the real doors: a turn that calls NO
// TOOL and merely restates *"it's already filed — sitting on your dashboard (report 067df9fa)"*
// binds nothing, so its stamp was immune FOR EVER. Worse, the three of BehaviorBot's six stamps
// that survived round 2's fix are the three whose attempts reached only `gather` — and `gather`
// takes no report_id, it ISSUES one.
//
// THE BINDING IS NOW THE PLATFORM'S OWN MINTED ID, wherever a recorded row of this agent names it:
// the call's JSON input, the `tool_result` that issued it ("Report <uuid> opened."), or the agent's
// own reply naming it — at any generation, in the short 8-character form the model writes. Chosen
// on measurements over 4,242 live answered asks, not on taste; the alternatives (report-lifetime
// windows, wider turn reach) and their collateral are in `report/withdrawn-claim.ts`'s header and
// in `.superpowers/sdd/DOJO-REPORT-PLAN/round3-red-fix-report.md`. Coverage: 8/8 of the known bad
// stamps. Cost: 13 of 4,242 (3.06/1000), and every one of the 13 is a genuine report ask.
//
// ── AND THE OTHER HALF OF THE BAR (§3) ──────────────────────────────────────────────────────
// The owner has a standing complaint that agents REPEAT THEMSELVES, and this machinery is what
// stops that (his 2026-08-09 incident: an agent re-investigating a question it had just answered).
// So suppression may not be weakened by one byte for anything BUT a withdrawn-report answer. §3 is
// that clause, and it is what the over-widening mutant fails.
//
// ── WHAT EACH SECTION HOLDS ─────────────────────────────────────────────────────────────────
//   §1 the reproduction shapes, one clause per carrier AND per generation
//   §2 the per-status table, three reads apiece        §5 one owner, the window, the one needle
//   §3 what must not move (the anti-repetition half)   §6 the fail-open: LOUD, and open
//   §4 the fifth carrier on its own                    §7 the accepted collateral, recorded
//
// ── MUTATION RECORD. Each planted in the product file named, measured, then reverted by restoring
// the byte-identical file (sha256 `52f38270` for `agent/v2/answered-edge.ts` and `e6d99ba6` for
// `report/withdrawn-claim.ts`, re-asserted after every one):
//
//   M1  predicate dropped from read 1  (`recentlyAnsweredAsks`)      15 F / 21 P  §1 §2 §3 §5 §6 §7
//   M2  predicate dropped from read 2  (`answeredPairsForMessages`)   7 F / 29 P  §1 §2 §5
//   M3  predicate dropped from carrier 5 (`recordedAnswer…`)          9 F / 27 P  §1 §2 §4 §5
//   M4  predicate INVERTED                                           17 F / 19 P  §1 §2 §3 §4 §6 §7
//   M5  predicate OVER-WIDENED (voids standing rows too)             10 F / 26 P  §1 §3 §6
//   M6  the fail-open's ERROR log deleted                             1 F / 35 P  §6
//   M7  the fail-open flipped to fail-CLOSED                          1 F / 35 P  §6
//   M8  RE-IMMUNIZE gen 1.5 + 2: id-naming restricted to envelopes    3 F / 33 P  §1 §5
//   M9  RE-IMMUNIZE gen 2: the 8-hex short form dropped               3 F / 33 P  §1 §5 §6
//   M10 RE-IMMUNIZE the mute shape: the one-turn reach removed         1 F / 35 P  §1
//
// M4 leaves §2's three STANDING rows green, and that is the reason §3 arms the cheap gate in its
// own `beforeEach`: with no withdrawn report on the agent the predicate short-circuits, so an
// inversion is invisible to any clause that does not put one there. M5 is the mutant §2 cannot see
// at all — it is what the unchanged-behaviour clauses exist for. M8/M9/M10 are round 3's own bar:
// each one re-immunizes exactly one generation, and each is red on the clause for that generation.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb: { current: Database.Database | null } = { current: null };

/** The logger, captured. §6 asserts a line the product MUST say out loud; a spy is the only way to
 *  hold "and it shouts" as a clause rather than as a hope. */
const h = vi.hoisted(() => {
  const calls = {
    debug: [] as unknown[][], info: [] as unknown[][],
    warn: [] as unknown[][], error: [] as unknown[][],
  };
  return {
    calls,
    logger: {
      debug: (...a: unknown[]) => { calls.debug.push(a); },
      info: (...a: unknown[]) => { calls.info.push(a); },
      warn: (...a: unknown[]) => { calls.warn.push(a); },
      error: (...a: unknown[]) => { calls.error.push(a); },
    },
  };
});

vi.mock('../../../logger.js', async (orig) => ({
  ...(await orig<typeof import('../../../logger.js')>()),
  createLogger: () => h.logger,
}));

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-withdrawn-report-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import {
  RECENTLY_ANSWERED_LIMIT,
  answeredPairsForMessages,
  recentlyAnsweredAsks,
  recordedAnswerInConversation,
  renderRecentlyAnsweredBlock,
} from '../answered-edge.js';
// ROUND 3: the predicate is its own module now, beside the state machine whose rows it reads.
import { answerStillStands } from '../../../report/withdrawn-claim.js';
import { renderRecallLane, type RecallLaneContext, type RecallLanePayload } from '../../../memory/recall-lane.js';
import type { LaneRender } from '../../../memory/lanes.js';
// ⚠ THE CONSENT DOORS ARE DELIBERATELY NOT IMPORTED. `approveOnce` / `markPosted` /
// `markExported` / `releaseApproval` MOVE the owner's one approval, and
// `tools/__tests__/the-report-tool-reaches-no-new-door.test.ts` census-checks that only a NAMED
// allowlist holds an edge to them. A read-side test does not need to spend an approval to know
// what `approved` and `posted` mean — §2 sets those states on the row — so this file stays off
// that allowlist rather than widening it for its own convenience.
import { attachDraft, cancelReport, createReport, getReport, submitForApproval } from '../../../report/store.js';
import { engineText } from './engine-sources.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** Comments stripped, the way the prefix-lane conformance clauses strip them: a module header
 *  that NAMES a thing must not be what satisfies (or trips) a structural clause. */
const stripComments = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const codeOf = (rel: string): string => stripComments(read(rel));

const AGENT = 'reporter';
const OTHER_AGENT = 'reporter-two';
const CONV = 'conv-dashboard';

/** The claim the round-2 red served for a cancelled row, carried verbatim. */
const THE_CLAIM =
  "Written up and sitting on your dashboard as a preview card — I can't send it myself; "
  + 'only you pressing Post on that card puts it in front of the Dojo\'s builders.';

const db = (): Database.Database => mockDb.current!;

let clock = 0;
/** Monotonic, one second apart, so `ORDER BY created_at DESC` is deterministic. */
const nextAt = (): number => (clock += 1000);

function seedMessage(p: {
  id: string; role: 'user' | 'assistant'; content: string;
  turnNumber?: number | null; agentId?: string; conversationId?: string | null;
}): string {
  db().prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, role, content, turn_number, created_at,
                           channel, sender_id, display_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'dashboard', 'owner', ?)`,
  ).run(p.id, p.agentId ?? AGENT, p.conversationId === undefined ? CONV : p.conversationId,
    p.role, p.content, p.turnNumber ?? null, nextAt(),
    p.role === 'user' ? 'user-text' : 'agent-text');
  return p.id;
}

/** A recorded `tool_use` row, written the shape the engine writes it (measured on the repro
 *  agents: `[{"type":"tool_use","name":"dojo_report","input":{"phase":…,"report_id":…}}]`). */
function seedToolCall(p: {
  id: string; turnNumber: number; phase: string; reportId: string | null;
  tool?: string; agentId?: string; conversationId?: string;
}): string {
  const input: Record<string, unknown> = { phase: p.phase };
  if (p.reportId !== null) input.report_id = p.reportId;
  const content = JSON.stringify([{
    type: 'tool_use', id: `call-${p.id}`, name: p.tool ?? 'dojo_report', input,
  }]);
  db().prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, role, content, turn_number, created_at,
                           display_kind)
     VALUES (?, ?, ?, 'assistant', ?, ?, ?, 'tool-turn')`,
  ).run(p.id, p.agentId ?? AGENT, p.conversationId ?? CONV, content, p.turnNumber, nextAt());
  return p.id;
}

/** A report row in an exact state. Direct INSERT on purpose: this file tests a READ, and the
 *  doors are exercised for real in §1's last clause. */
function seedReport(id: string, status: string, agentId = AGENT): string {
  db().prepare(
    `INSERT INTO dojo_reports (id, agent_id, status, lane, signature)
     VALUES (?, ?, ?, 'other', ?)`,
  ).run(id, agentId, status, `sig-${id}`);
  return id;
}

interface Episode { askId: string; answerId: string }

/**
 * ONE ANSWERED ASK, with the report work recorded inside the WINDOW the stamp spans — raw turn
 * equality plus the ask→answer `seq` range, which is all the predicate claims (§7 holds the
 * collateral that phrasing admits; "the answering episode" would overstate it).
 *
 * `shape` is the measured difference between the two real arms, and both are seeded here:
 *   'same-turn'  — the kit-driven agent (BehaviorBot, six asks): the calls and the answer share
 *                  one turn, and the call row lands AFTER the answer row;
 *   'cross-turn' — Arm B on the dev box: the calls are recorded on turn N (seq 83301/83303/
 *                  83305) and the ask's stamp points at turn N+1's reply (seq 83314), because
 *                  the engine's "you have not spoken yet this turn" hint opens a new turn.
 */
function seedAnsweredReportAsk(p: {
  key: string; reportIds: Array<string | null>; shape?: 'same-turn' | 'cross-turn';
  askContent?: string; answerContent?: string; turn?: number; tool?: string;
}): Episode {
  const shape = p.shape ?? 'cross-turn';
  const turn = p.turn ?? 1;
  const askId = seedMessage({
    id: `ask-${p.key}`, role: 'user',
    content: p.askContent ?? 'Something went wrong earlier and I want it flagged. Twice this afternoon…',
  });
  if (shape === 'cross-turn') {
    p.reportIds.forEach((rid, i) => seedToolCall({
      id: `call-${p.key}-${i}`, turnNumber: turn, phase: rid === null ? 'gather' : 'submit',
      reportId: rid, tool: p.tool,
    }));
  }
  const answerId = seedMessage({
    id: `ans-${p.key}`, role: 'assistant', content: p.answerContent ?? THE_CLAIM,
    turnNumber: shape === 'cross-turn' ? turn + 1 : turn,
  });
  if (shape === 'same-turn') {
    // The calls land after the answer row, inside the same turn: the `turn_number` arm of the
    // window is the only thing that can see them.
    p.reportIds.forEach((rid, i) => seedToolCall({
      id: `call-${p.key}-${i}`, turnNumber: turn, phase: rid === null ? 'gather' : 'submit',
      reportId: rid, tool: p.tool,
    }));
  }
  db().prepare('UPDATE messages SET answer_message_id = ?, served_by_turn = ? WHERE id = ?')
    .run(answerId, turn, askId);
  return { askId, answerId };
}

/**
 * ROUND 3's SHAPES — the generations the `input.report_id` binding could not reach.
 *
 *  'gather-only'  — BehaviorBot 83209/83220: the turn calls `dojo_report phase=gather`, which
 *                   takes no report_id and ISSUES one; the only trace is the platform's own
 *                   tool_result row, "Report <uuid> opened.". The reply then lies about it.
 *  'restates-id'  — the round-3 scratch reproduction (83389/83391): NO tool call at all, the
 *                   reply names the report ("report 067df9fa" — the short form the model uses).
 *  'restates-mute'— BehaviorBot 83265: no tool call, no id, one turn after the work that died.
 */
function seedRound3Ask(p: {
  key: string; reportId: string; shape: 'gather-only' | 'restates-id' | 'restates-mute';
  turn?: number;
}): Episode {
  const turn = p.turn ?? 30;
  if (p.shape === 'restates-mute') {
    // The previous turn carries the platform-witnessed work; THIS turn carries only prose.
    seedToolCall({ id: `call-${p.key}-prev`, turnNumber: turn - 1, phase: 'submit', reportId: p.reportId });
    seedMessage({ id: `ans-${p.key}-prev`, role: 'assistant', content: 'Filed it.', turnNumber: turn - 1 });
  }
  const askId = seedMessage({
    id: `ask-${p.key}`, role: 'user', content: 'That refusal problem I raised — can you get it in front of them?',
  });
  if (p.shape === 'gather-only') {
    seedToolCall({ id: `call-${p.key}`, turnNumber: turn, phase: 'gather', reportId: null });
    seedToolResult({
      id: `res-${p.key}`, turnNumber: turn,
      content: `Report ${p.reportId} opened. Window: the last 20 turns within the last 120 minutes.`,
    });
  }
  const answerId = seedMessage({
    id: `ans-${p.key}`, role: 'assistant', turnNumber: turn,
    content: p.shape === 'restates-id'
      ? `It's already filed as far as I'm able — the write-up is sitting on your dashboard as a `
        + `preview card (report ${p.reportId.slice(0, 8)}, tool-error lane).`
      : 'Already filed — the write-up is sitting on your dashboard as a preview card, and the only '
        + 'step left is you pressing Post; I can\'t publish it myself.',
  });
  db().prepare('UPDATE messages SET answer_message_id = ?, served_by_turn = ? WHERE id = ?')
    .run(answerId, turn, askId);
  return { askId, answerId };
}

/** A recorded `tool_result` row — the platform's OWN words, which is where `gather` puts the id. */
function seedToolResult(p: { id: string; turnNumber: number; content: string }): string {
  const content = JSON.stringify([{ type: 'tool_result', tool_use_id: `call-${p.id}`, content: p.content }]);
  db().prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, role, content, turn_number, created_at,
                           display_kind)
     VALUES (?, ?, ?, 'tool', ?, ?, ?, 'tool-turn')`,
  ).run(p.id, AGENT, CONV, content, p.turnNumber, nextAt());
  return p.id;
}

/** An ordinary answered ask with no report anywhere near it. */
function seedPlainAnsweredAsk(key: string, ask: string, answer: string): Episode {
  const askId = seedMessage({ id: `ask-${key}`, role: 'user', content: ask });
  const answerId = seedMessage({ id: `ans-${key}`, role: 'assistant', content: answer, turnNumber: 90 });
  db().prepare('UPDATE messages SET answer_message_id = ?, served_by_turn = 90 WHERE id = ?')
    .run(answerId, askId);
  return { askId, answerId };
}

const listedAskIds = (): string[] =>
  recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT).map((a) => a.askId);

const injectedBlock = (): string | null =>
  renderRecentlyAnsweredBlock(recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT));

function laneCtx(over: Partial<RecallLaneContext> = {}): RecallLaneContext {
  return {
    agentId: AGENT, includeVault: false, excludeIds: new Set<string>(),
    msgHits: [], vaultHits: [], alreadyAnsweredAskIds: new Set<string>(), ...over,
  };
}
const laneText = (r: LaneRender<RecallLanePayload> | null): string =>
  (r?.messages?.[0]?.content as string | undefined) ?? '';
/** The verbatim-quote carrier, rendered: what `msg.relevant-memory` would actually inject. */
const quotedAnswerFor = (e: Episode): string =>
  laneText(renderRecallLane(laneCtx({ msgHits: [{ sourceId: e.askId }] })));

beforeEach(() => {
  clock = Date.UTC(2026, 8, 26, 9, 0, 0);
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const id of [AGENT, OTHER_AGENT]) {
    db().prepare(
      `INSERT INTO agents (id, name, status, session_started_at)
       VALUES (?, ?, 'idle', '1970-01-01')`,
    ).run(id, id);
  }
  db().prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES (?, ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — ARM B AT UNIT LEVEL. The whole red, in one clause per carrier.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the ARM B shape: cancel the card, and the stamp stops being evidence', () => {
  it('with the card STILL on the dashboard, every carrier speaks exactly as before', () => {
    const rid = seedReport('rep-standing', 'awaiting_approval');
    const e = seedAnsweredReportAsk({ key: 'b1', reportIds: [rid] });

    expect(listedAskIds()).toEqual([e.askId]);
    expect(injectedBlock()).toContain('Something went wrong earlier');
    expect(answeredPairsForMessages(AGENT, [e.askId]).get(e.askId)?.answerContent).toBe(THE_CLAIM);
    expect(quotedAnswerFor(e)).toContain('sitting on your dashboard');
    expect(recordedAnswerInConversation(AGENT, CONV)).toBe(THE_CLAIM);
    // The predicate's own verdict, stated once so the clauses below cannot pass for the wrong
    // reason (a seeding mistake reads as "voided" everywhere).
    expect(answerStillStands(AGENT, ...spanOf(e))).toBe(true);
  });

  it('the card WITHDRAWN: both reads drop it, the injected block carries nothing about it', () => {
    const rid = seedReport('rep-gone', 'awaiting_approval');
    const e = seedAnsweredReportAsk({ key: 'b2', reportIds: [rid] });
    const before = injectedBlock();
    expect(before).toContain('Something went wrong earlier'); // the RED's own input

    db().prepare("UPDATE dojo_reports SET status = 'cancelled' WHERE id = ?").run(rid);

    // READ 1 — `engine.recently-answered`'s list AND the recall lane's dedup set.
    expect(listedAskIds()).toEqual([]);
    expect(injectedBlock()).toBeNull();
    // READ 2 — the verbatim-quote carrier.
    expect(answeredPairsForMessages(AGENT, [e.askId, e.answerId]).size).toBe(0);
    // …and the block that quote rides in no longer asserts anything as answered.
    const lane = quotedAnswerFor(e);
    expect(lane).not.toContain('ALREADY ANSWERED');
    expect(lane).not.toContain('Do NOT re-run the work');
    // CARRIER 5 — the ghosted-ask ladder's second rung.
    expect(recordedAnswerInConversation(AGENT, CONV)).toBeNull();
  });

  it('DOCUMENTED RESIDUAL: the withdrawn claim may still be RECALLED, stripped of authority', () => {
    // Honest about what this fix does NOT do. A hit on the ANSWER row still renders under
    // "Older messages retrieved by meaning" — that is the recall lane's ordinary job and
    // touching its retrieval is out of this task's blast radius. What it loses is the part that
    // made it a false RECORD: the engine's "engine record … do NOT re-run the work" framing.
    //
    // ⚠ THE POSITIVE HALF IS THE CLAUSE (review F6). Written negative-only, this would have stayed
    // green if the lane rendered NOTHING AT ALL — which would make the title's "may still be
    // recalled" a claim the test never checked. It now asserts the sentence IS there, under the
    // retrieval head, so the day the lane stops emitting it this clause fails and the disclosure in
    // the fix report gets corrected instead of quietly rotting.
    const rid = seedReport('rep-residual', 'awaiting_approval');
    const e = seedAnsweredReportAsk({ key: 'b3', reportIds: [rid] });
    db().prepare("UPDATE dojo_reports SET status = 'cancelled' WHERE id = ?").run(rid);

    const lane = laneText(renderRecallLane(laneCtx({ msgHits: [{ sourceId: e.answerId }] })));
    expect(lane).toContain('Older messages retrieved by meaning');
    expect(lane).toContain('sitting on your dashboard as a preview card');
    expect(lane).not.toContain('Do NOT re-run the work');
    expect(lane).not.toContain('ALREADY ANSWERED');
  });

  it('ROUND 3 · GENERATION 1.5 — a `gather`-only turn binds through the RESULT that issued the id', () => {
    // BehaviorBot 83209 and 83220, and the reason rounds 1-2 could not reach them: `gather` takes
    // no report_id, it ISSUES one, so the agent's own call row names nothing. The platform's
    // tool_result row does — "Report <uuid> opened." — and that row is recorded like any other.
    const rid = seedReport('8a1b2c3d-0000-4000-8000-000000000001', 'cancelled');
    const e = seedRound3Ask({ key: 'gatheronly', reportId: rid, shape: 'gather-only', turn: 30 });
    expect(answerStillStands(AGENT, ...spanOf(e))).toBe(false);
    expect(listedAskIds()).toEqual([]);
    expect(answeredPairsForMessages(AGENT, [e.askId]).size).toBe(0);
    expect(recordedAnswerInConversation(AGENT, CONV)).toBeNull();
  });

  it('ROUND 3 · GENERATION 2 — a restatement that only NAMES the report is bound by that name', () => {
    // The round-3 red itself, on a clean agent: no tool call in the turn at all, the reply says
    // "(report 067df9fa)" — the 8-character short form the model writes. Immune for ever under the
    // old binding; bound now, because the id is the platform's own and it recognises it.
    const rid = seedReport('067df9fa-1111-4000-8000-000000000002', 'cancelled');
    const e = seedRound3Ask({ key: 'restated', reportId: rid, shape: 'restates-id', turn: 40 });
    expect(answerStillStands(AGENT, ...spanOf(e))).toBe(false);
    expect(listedAskIds()).toEqual([]);
    expect(recordedAnswerInConversation(AGENT, CONV)).toBeNull();
    // …and the SHORT form is what did it: the full uuid never appears in that reply.
    const ans = db().prepare('SELECT content FROM messages WHERE id = ?').get(e.answerId) as { content: string };
    expect(ans.content).not.toContain(rid);
    expect(ans.content).toContain(rid.slice(0, 8));
  });

  it('ROUND 3 · GENERATION 2, MUTE — no call and no id, one turn after the work that died', () => {
    // BehaviorBot 83265: the hardest shape, and the reason the window reaches ONE turn back.
    const rid = seedReport('9c8b7a65-2222-4000-8000-000000000003', 'cancelled');
    const e = seedRound3Ask({ key: 'mute', reportId: rid, shape: 'restates-mute', turn: 50 });
    const ans = db().prepare('SELECT content FROM messages WHERE id = ?').get(e.answerId) as { content: string };
    expect(ans.content).not.toContain(rid.slice(0, 8)); // it names nothing at all
    expect(answerStillStands(AGENT, ...spanOf(e))).toBe(false);
    expect(listedAskIds()).toEqual([]);
  });

  it('…and TWO turns back is NOT reached — the residual, stated as a clause', () => {
    // Measured: reaching two turns back is what starts voiding "How many centimetres are there in
    // one metre?" on the live corpus, so the reach stops at one and this is the cost. 0 stamps of
    // the live 4,242 have this shape; closing it properly wants `dojo_reports.ask_id`.
    const rid = seedReport('7d6e5f44-3333-4000-8000-000000000004', 'cancelled');
    const e = seedRound3Ask({ key: 'far', reportId: rid, shape: 'restates-mute', turn: 60 });
    // Push the work one turn further back than the window reaches.
    db().prepare('UPDATE messages SET turn_number = 57 WHERE id IN (?, ?)')
      .run('call-far-prev', 'ans-far-prev');
    expect(answerStillStands(AGENT, ...spanOf(e))).toBe(true);
    expect(listedAskIds()).toEqual([e.askId]);
  });

  it('BOTH measured window shapes are covered: cross-turn (Arm B) and same-turn (the kit)', () => {
    const cross = seedReport('rep-cross', 'cancelled');
    const same = seedReport('rep-same', 'cancelled');
    const a = seedAnsweredReportAsk({ key: 'w1', reportIds: [cross], shape: 'cross-turn', turn: 10 });
    const b = seedAnsweredReportAsk({ key: 'w2', reportIds: [same], shape: 'same-turn', turn: 20 });

    expect(answerStillStands(AGENT, ...spanOf(a))).toBe(false);
    expect(answerStillStands(AGENT, ...spanOf(b))).toBe(false);
    expect(listedAskIds()).toEqual([]);
  });

  it('END TO END THROUGH THE REAL DOORS: `cancelReport()` is what voids it', () => {
    const row = createReport(AGENT, 'wrong-answer', 'sig-live');
    attachDraft(row.id, {
      lane: 'wrong-answer', signature: 'sig-live',
      brief: {
        title: 'a title', whatHappened: 'x', whatShouldHaveHappened: 'y',
        whyItWentWrong: 'z', fixIdeas: 'w',
      },
      telemetry: {}, bundlePath: '/tmp/bundle.json',
    });
    expect(submitForApproval(row.id)?.status).toBe('awaiting_approval');
    const e = seedAnsweredReportAsk({ key: 'live', reportIds: [row.id] });
    expect(listedAskIds()).toEqual([e.askId]);

    expect(cancelReport(row.id)?.status).toBe('cancelled');
    expect(getReport(row.id)?.status).toBe('cancelled');
    expect(listedAskIds()).toEqual([]);
    expect(recordedAnswerInConversation(AGENT, CONV)).toBeNull();
  });

  it('and a row that walks ON to approved and posted keeps standing at every step', () => {
    const row = createReport(AGENT, 'wrong-answer', 'sig-posted');
    attachDraft(row.id, {
      lane: 'wrong-answer', signature: 'sig-posted',
      brief: {
        title: 'a title', whatHappened: 'x', whatShouldHaveHappened: 'y',
        whyItWentWrong: 'z', fixIdeas: 'w',
      },
      telemetry: {}, bundlePath: '/tmp/bundle.json',
    });
    expect(submitForApproval(row.id)?.status).toBe('awaiting_approval');
    const e = seedAnsweredReportAsk({ key: 'posted', reportIds: [row.id] });
    // The two states past the card are set on the row, not spent through the consent doors —
    // see the import note at the top of this file.
    for (const status of ['approved', 'posted']) {
      db().prepare('UPDATE dojo_reports SET status = ? WHERE id = ?').run(status, row.id);
      expect(getReport(row.id)?.status).toBe(status);
      expect(listedAskIds()).toEqual([e.askId]);
      expect(recordedAnswerInConversation(AGENT, CONV)).toBe(THE_CLAIM);
    }
  });
});

/** The predicate's own two arguments, read off the rows the seeding wrote. */
function spanOf(e: Episode): [number, string] {
  const r = db().prepare(
    'SELECT seq, answer_message_id AS ans FROM messages WHERE id = ?',
  ).get(e.askId) as { seq: number; ans: string };
  return [r.seq, r.ans];
}

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE PER-STATUS TABLE. Every report state × every read, in one place, so the direction
// of each state is a row somebody can read rather than a sentence somebody remembers.
// ════════════════════════════════════════════════════════════════════════════════════════

const TABLE: Array<{ status: string; stands: boolean; why: string }> = [
  { status: 'awaiting_approval', stands: true, why: 'the preview card is on the dashboard' },
  { status: 'approved', stands: true, why: 'decided, waiting on the transport' },
  { status: 'posted', stands: true, why: 'delivered — and this is also the export door\'s state' },
  { status: 'cancelled', stands: false, why: 'WITHDRAWN: nothing is on the dashboard' },
  { status: 'drafting', stands: false, why: 'PREMATURE: round 1\'s false-filed shape, never submitted' },
  { status: 'exported', stands: false, why: 'not a status this release writes — rule 4\'s safe direction' },
];

describe('§2 the per-status table, over all three reads', () => {
  for (const row of TABLE) {
    it(`${row.status} -> ${row.stands ? 'LISTED and QUOTED' : 'VOID'} (${row.why})`, () => {
      const rid = seedReport(`rep-${row.status}`, row.status);
      const e = seedAnsweredReportAsk({ key: `t-${row.status}`, reportIds: [rid] });

      // read 1 — the list `engine.recently-answered` renders and the lane dedups against
      expect(listedAskIds()).toEqual(row.stands ? [e.askId] : []);
      // read 2 — the verbatim answer quote
      expect(answeredPairsForMessages(AGENT, [e.askId]).has(e.askId)).toBe(row.stands);
      expect(quotedAnswerFor(e).includes('sitting on your dashboard')).toBe(row.stands);
      // carrier 5 — the no-reply ladder's recorded-answer quote
      expect(recordedAnswerInConversation(AGENT, CONV)).toBe(row.stands ? THE_CLAIM : null);
      // and the predicate itself, so a table row cannot pass by accident of seeding
      expect(answerStillStands(AGENT, ...spanOf(e))).toBe(row.stands);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — WHAT MUST NOT MOVE. The owner's standing complaint is that agents REPEAT THEMSELVES;
// this machinery is what stops that. Every clause here runs with a withdrawn report ALREADY on
// the agent (so the predicate's cheap gate is armed and the join really runs) and asserts the
// answer is listed and quoted anyway.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 suppression is untouched for everything but a withdrawn-report answer', () => {
  beforeEach(() => {
    // The gate is armed for every clause below: this agent HAS a cancelled report.
    seedReport('rep-unrelated-cancelled', 'cancelled');
  });

  it('an ordinary ask with no report anywhere is listed, paired and quoted, unchanged', () => {
    const e = seedPlainAnsweredAsk('plain', 'how much was the Asana plan?', 'About $395 a year.');
    expect(listedAskIds()).toEqual([e.askId]);
    expect(injectedBlock()).toContain('how much was the Asana plan');
    expect(answeredPairsForMessages(AGENT, [e.askId]).get(e.askId)?.answerContent)
      .toBe('About $395 a year.');
    expect(quotedAnswerFor(e)).toContain('About $395 a year.');
    expect(recordedAnswerInConversation(AGENT, CONV)).toBe('About $395 a year.');
  });

  it('BYTE-IDENTICAL: the block a plain conversation renders does not move when a report is cancelled', () => {
    seedPlainAnsweredAsk('p1', 'what is the boat insurance number?', 'It is 44-291.');
    seedPlainAnsweredAsk('p2', 'and the policy start date?', 'March 3rd.');
    const rid = seedReport('rep-byte', 'awaiting_approval');
    const before = injectedBlock();
    db().prepare("UPDATE dojo_reports SET status = 'cancelled' WHERE id = ?").run(rid);
    // No ask on this agent was answered by an episode that filed `rep-byte`, so not one byte of
    // the block may change.
    expect(injectedBlock()).toBe(before);
  });

  it('a turn that RE-FILED after a cancel still stands (Arm A: one withdrawn row, one live)', () => {
    const gone = seedReport('rep-a-gone', 'cancelled');
    const live = seedReport('rep-b-live', 'awaiting_approval');
    const e = seedAnsweredReportAsk({ key: 'arma', reportIds: [gone, live] });
    expect(answerStillStands(AGENT, ...spanOf(e))).toBe(true);
    expect(listedAskIds()).toEqual([e.askId]);
    expect(quotedAnswerFor(e)).toContain('sitting on your dashboard');
  });

  it('a `gather`-only episode binds no row, so nothing is voided', () => {
    const e = seedAnsweredReportAsk({ key: 'gather', reportIds: [null] });
    expect(answerStillStands(AGENT, ...spanOf(e))).toBe(true);
    expect(listedAskIds()).toEqual([e.askId]);
  });

  it('a report_id that resolves to NO row is not a withdrawal', () => {
    const e = seedAnsweredReportAsk({ key: 'ghost', reportIds: ['rep-never-existed'] });
    expect(answerStillStands(AGENT, ...spanOf(e))).toBe(true);
    expect(listedAskIds()).toEqual([e.askId]);
  });

  it('ROUND 3 CHANGED THIS ONE: the binding is the ID, not the tool that named it', () => {
    // It used to assert the opposite — `$.name = 'dojo_report'` was part of the key, so a
    // `work_update` call carrying the same id bound nothing. Round 3's red is why that key is
    // gone: the failing shape called NO TOOL AT ALL and merely restated "it's filed (report
    // 067df9fa)", so a tool name cannot be what makes a row evidence. What makes it evidence is
    // that it names an id THIS PLATFORM MINTED for THIS agent. Measured cost of dropping the
    // tool key: zero additional collateral over 4,242 live answered asks.
    const rid = seedReport('rep-other-tool', 'cancelled');
    const e = seedAnsweredReportAsk({ key: 'othertool', reportIds: [rid], tool: 'work_update' });
    expect(answerStillStands(AGENT, ...spanOf(e))).toBe(false);
    expect(listedAskIds()).toEqual([]);
  });

  it('a row naming NOTHING binds nothing, whatever tool it called', () => {
    // The other half of the same rule, and the one that keeps the widening honest.
    seedReport('rep-elsewhere-only', 'cancelled');
    const e = seedAnsweredReportAsk({ key: 'noname', reportIds: [null], tool: 'work_update' });
    expect(answerStillStands(AGENT, ...spanOf(e))).toBe(true);
    expect(listedAskIds()).toEqual([e.askId]);
  });

  it('another AGENT\'s cancelled report cannot void this agent\'s answer', () => {
    const theirs = seedReport('rep-theirs', 'cancelled', OTHER_AGENT);
    const e = seedAnsweredReportAsk({ key: 'scope', reportIds: [theirs] });
    expect(answerStillStands(AGENT, ...spanOf(e))).toBe(true);
    expect(listedAskIds()).toEqual([e.askId]);
  });

  it('a report filed AFTER the answer landed belongs to a later ask, not this one', () => {
    const e = seedPlainAnsweredAsk('earlier', 'did the invoice go out?', 'Yes, this morning.');
    const later = seedReport('rep-later', 'cancelled');
    // A different, LATER episode files and loses a report. The earlier answer is untouched.
    seedToolCall({ id: 'call-later', turnNumber: 91, phase: 'submit', reportId: later });
    expect(answerStillStands(AGENT, ...spanOf(e))).toBe(true);
    expect(listedAskIds()).toContain(e.askId);
  });

  it('the LIST SHORTENS, it does not reach further back for a fourth ask', () => {
    // Four answered asks, the newest of them a withdrawn report. The block must show the two
    // remaining newest — NOT pull the fourth-oldest up to refill the cap, which would put a
    // claim in front of the model it was never going to see and change the lane's dedup set.
    const p1 = seedPlainAnsweredAsk('s1', 'oldest question?', 'oldest answer.');
    const p2 = seedPlainAnsweredAsk('s2', 'middle question?', 'middle answer.');
    const p3 = seedPlainAnsweredAsk('s3', 'newer question?', 'newer answer.');
    const rid = seedReport('rep-shorten', 'cancelled');
    seedAnsweredReportAsk({ key: 'shorten', reportIds: [rid] });

    expect(listedAskIds()).toEqual([p3.askId, p2.askId]);
    expect(injectedBlock()).not.toContain('oldest question');
    expect(recentlyAnsweredAsks(AGENT, CONV, RECENTLY_ANSWERED_LIMIT).length)
      .toBeLessThan(RECENTLY_ANSWERED_LIMIT);
    // The pair reader is not shortened by the cap, so p1 is still quotable by MEANING — that
    // path is unchanged, which is the point of not refilling.
    expect(answeredPairsForMessages(AGENT, [p1.askId]).has(p1.askId)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE FIFTH CARRIER, on its own. `no-reply.ts`'s second steer quotes
// `recordedAnswerInConversation` under "you already answered this … Do not re-do the work".
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 the ghosted-ask ladder is not handed a withdrawn claim to restate', () => {
  it('the newest settled ask is a withdrawn report: the rung gets nothing', () => {
    seedPlainAnsweredAsk('older', 'what time is the call?', 'Three o\'clock.');
    const rid = seedReport('rep-fifth', 'awaiting_approval');
    seedAnsweredReportAsk({ key: 'fifth', reportIds: [rid] });
    expect(recordedAnswerInConversation(AGENT, CONV)).toBe(THE_CLAIM);

    db().prepare("UPDATE dojo_reports SET status = 'cancelled' WHERE id = ?").run(rid);

    // Null, not the OLDER answer: this read is scoped to the newest settled ask, and quoting a
    // different one would put a claim in front of the model that was never on offer.
    expect(recordedAnswerInConversation(AGENT, CONV)).toBeNull();
    expect(recordedAnswerInConversation(AGENT, CONV)).not.toBe('Three o\'clock.');
  });

  it('a standing answer is still handed over, verbatim', () => {
    const rid = seedReport('rep-5-live', 'awaiting_approval');
    seedAnsweredReportAsk({ key: 'fifthlive', reportIds: [rid] });
    expect(recordedAnswerInConversation(AGENT, CONV)).toBe(THE_CLAIM);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — ONE OWNER, STRUCTURALLY. The reason the predicate lives in `answered-edge.ts` is that a
// carrier cannot inherit a check it has to remember to make.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 the predicate has one home and every read applies it', () => {
  it('all three reads call the SAME predicate, and only ONE module defines it', () => {
    const edge = codeOf('agent/v2/answered-edge.ts');
    const claim = codeOf('report/withdrawn-claim.ts');
    // Three calls in the edge — one per read — and no definition: round 3 moved the predicate to
    // its own module rather than taking a third ceiling raise on the edge.
    expect(edge.match(/answerStillStands\(/g) ?? []).toHaveLength(3);
    expect(edge).toContain("from '../../report/withdrawn-claim.js'");
    expect(edge, 'the edge must not re-acquire the report vocabulary it just handed over')
      .not.toContain('STANDING_REPORT_STATUSES');
    expect(edge).not.toContain('dojo_reports');
    // …and the definition is there, exactly once.
    expect(claim.match(/export function answerStillStands/g) ?? []).toHaveLength(1);
    expect(claim).toContain('STANDING_REPORT_STATUSES');
  });

  it('no carrier re-derives report state at its own injection site', () => {
    // THE ENGINE HALF comes from the shared derivation, never by path: carriers 1 and 5 live in
    // `agent/v2/steps/`, PHASE-6 moves code within that tree, and a by-path negative clause goes
    // QUIET instead of red when its subject moves (`__tests__/guard-corpus-census.test.ts`).
    const corpus = [stripComments(engineText()), codeOf('memory/recall-lane.ts')];
    for (const code of corpus) {
      expect(code).not.toContain('dojo_reports');
      expect(code).not.toContain('awaiting_approval');
    }
  });

  it('each arm of the window is its OWN statement, and neither is assembled at runtime', () => {
    // Review F1: the two arms were one statement with `(turn_number = ? OR (seq BETWEEN …))`, and
    // an OR across two indexes gets neither — 18.7 ms per call on the ritual's own agent, 52.4 ms
    // for one `recentlyAnsweredAsks(3)`, on EVERY model call. Split, each arm is indexed (0.023 /
    // 0.022 ms; the whole read 0.253 ms). This clause holds the SHAPE that makes that true, because
    // the timings themselves are not assertable in a unit test: two literal statements, each with
    // exactly one row filter, and no `${}` in either — the SQL gate prepares literals against the
    // migrated schema and a builder would put both beyond its reach.
    const claim = codeOf('report/withdrawn-claim.ts');
    expect(claim).toContain('AND m.turn_number BETWEEN ? AND ?');
    expect(claim).toContain('AND m.seq >= ? AND m.seq <= ?');
    expect(claim, 'the OR is what defeated both indexes; it must not come back')
      .not.toMatch(/m\.turn_number BETWEEN \? AND \?\s*OR/);
    expect(claim.match(/SELECT DISTINCT r\.id AS id, r\.status AS status/g) ?? []).toHaveLength(2);
    for (const stmt of claim.split('const REPORTS_NAMED_IN_').slice(1)) {
      expect(stmt.split('`')[1] ?? '', 'a runtime-assembled arm is invisible to the SQL gate')
        .not.toContain('${');
    }
  });

  it('the ONLY text it matches is an id the platform minted — never a word, never a phrase', () => {
    const claim = codeOf('report/withdrawn-claim.ts');
    const edge = codeOf('agent/v2/answered-edge.ts');
    for (const smell of ['preview card', 'dashboard as a', 'looksLikeAnswer', 'CLOSEOUT', 'already filed']) {
      expect(claim).not.toContain(smell);
      expect(edge).not.toContain(smell);
    }
    // Round 3's rule DOES match text, and this is the clause that keeps it narrow: every LIKE in
    // the module takes its needle from `substr(r.id, 1, 8)` — the first 8 hex of a UUID this
    // platform minted, read out of `dojo_reports` — and from nothing else. A phrase list, a lane
    // word or a hand-written id would fail here.
    const likes = claim.match(/LIKE[^\n]*/g) ?? [];
    expect(likes.length).toBe(2);
    for (const like of likes) expect(like).toContain("'%' || substr(r.id, 1, 8) || '%'");
    expect(claim).not.toMatch(/LIKE\s*'%[a-zA-Z]/);
    // The tool_use ENVELOPE prefilter is gone with the JSON: the id-naming rule needs prose rows,
    // and the edge keeps exactly one (`substantiveReplySince`'s NOT LIKE, which predates all this).
    expect(edge.match(/\[\{%/g) ?? []).toHaveLength(1);
    expect(claim).not.toContain('json_each');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §6 — THE INSTRUMENT FAILING IS LOUD, AND IT FAILS OPEN (review F4).
//
// `answerStillStands` catches its own throw and returns `true` — the ONE place this fix silently
// reverts to the pre-fix behaviour, and unpinned it left 111 clauses green when the reviewer flipped
// it. The direction is ADJUDICATED and stays `true`: a throw is the INSTRUMENT failing, not
// ambiguity about whether the person was answered, and failing closed would void EVERY answered ask
// on the agent (all three reads filter through this), which re-opens the owner's repeat-yourself
// incident across the board on one malformed row. What was missing is that it said nothing. Both
// halves are held below, and both are mutant-proven.
// ════════════════════════════════════════════════════════════════════════════════════════

/** Make the WINDOW queries — and only those — throw, so the predicate's own catch is exercised.
 *  Everything else on the connection passes straight through, including the gate and the answer-row
 *  resolve, so the failure lands exactly where the clause says it does. */
function breakTheWindowQuery(): () => void {
  const real = db();
  mockDb.current = new Proxy(real, {
    get(target, prop, recv) {
      if (prop === 'prepare') {
        return (sql: string, ...rest: unknown[]) => {
          // Keyed on the window statements' own shape (the `substr(r.id, …)` needle), so the gate
          // read and the answer-row resolve still work and the failure lands where §6 says.
          if (sql.includes('substr(r.id')) throw new Error('database disk image is malformed');
          return (target.prepare as (s: string, ...r: unknown[]) => unknown)(sql, ...rest);
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Database.Database;
  return () => { mockDb.current = real; };
}

describe('§6 the instrument failing is LOUD, and it fails OPEN', () => {
  it('a throw in the window query keeps every answer listed AND shouts at error level', () => {
    const rid = seedReport('rep-loud', 'cancelled');
    const plain = seedPlainAnsweredAsk('loud', 'what time is the call?', 'Three o\'clock.');
    const e = seedAnsweredReportAsk({ key: 'loud2', reportIds: [rid] });
    // Positive control on the fixture: with the instrument WORKING, the report ask is voided and
    // the ordinary ask is not. A green below cannot come from nothing having been withdrawn.
    expect(listedAskIds()).toEqual([plain.askId]);

    h.calls.error.length = 0;
    const restore = breakTheWindowQuery();
    try {
      // FAILS OPEN, both halves of what that means: the withdrawn ask is listed again (the pre-fix
      // behaviour, and the cost of this direction) AND the ORDINARY ask keeps its anti-repetition,
      // which is the reason the direction is `true` rather than `false`.
      expect(listedAskIds()).toEqual([e.askId, plain.askId]);
      expect(recordedAnswerInConversation(AGENT, CONV)).toBe(THE_CLAIM);
    } finally {
      restore();
    }

    // …and it is on the record at ERROR, naming the ask it could not check. A silent revert to the
    // behaviour this task exists to remove is how the defect comes back.
    expect(h.calls.error.length, 'the fail-open must not be silent').toBeGreaterThan(0);
    const [message, meta] = h.calls.error[0] as [string, Record<string, unknown>];
    expect(message).toContain('withdrawn-report check could not run');
    expect(message).toContain('STANDS');
    expect(meta).toMatchObject({ answerMessageId: e.answerId });
    expect(String(meta.error)).toContain('malformed');
    // The word every operator greps for. It is an ERROR, not a warn and not a debug.
    expect(h.calls.warn).toHaveLength(0);
  });

  it('the gate\'s own catch is the same direction, and a DB with no report table changes nothing', () => {
    const e = seedPlainAnsweredAsk('nogate', 'did the invoice go out?', 'Yes, this morning.');
    db().prepare('DROP TABLE dojo_reports').run();
    // No report table means no reports, which is the same answer as "no withdrawn report" — the
    // pre-fix behaviour, reached without an error line because nothing failed: there is nothing
    // to check on that box.
    h.calls.error.length = 0;
    expect(listedAskIds()).toEqual([e.askId]);
    expect(h.calls.error).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §7 — THE ACCEPTED COLLATERAL, WRITTEN DOWN (review F3 / F7).
//
// The window is RAW CONTAINMENT, not a binding to the ask, and the review measured four over-void
// shapes it admits. Two are held here so the behaviour is RECORDED rather than merely tolerated: a
// future task that narrows the window (the `dojo_reports.ask_id` column the investigation named)
// turns these red, which is the moment to delete them — they are characterization, and they say so.
//
// WHY THIS IS THE ACCEPTED DIRECTION, measured over the live body rather than assumed: 8 of 4,240
// answered asks on gate-armed agents are voided, and ALL EIGHT are genuine report asks — zero
// collateral in production today. The enabling fan-out is 89 of 4,511 stamped asks (~2%), and it
// additionally needs that batch to hold report work that later dies. An over-void costs one
// unrelated ask its anti-repetition — the owner may hear an answer twice, which 2026-08-05 chooses
// out loud — while the under-void direction IS the round-2 red.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§7 characterization: the over-void shapes the window admits', () => {
  it('two asks stamped by ONE turn are voided together (the batch shape)', () => {
    const rid = seedReport('rep-batch', 'cancelled');
    const e = seedAnsweredReportAsk({ key: 'batch', reportIds: [rid], shape: 'same-turn', turn: 7 });
    // A second ask the SAME turn answered — `setAnswerMessageId` stamps every row it served.
    const other = seedMessage({ id: 'ask-batch-2', role: 'user', content: 'and what is the weather?' });
    db().prepare('UPDATE messages SET answer_message_id = ?, served_by_turn = 7 WHERE id = ?')
      .run(e.answerId, other);

    expect(listedAskIds(), 'accepted collateral: the batch partner loses its stamp too').toEqual([]);
  });

  it('a report call in ANOTHER conversation inside the seq span voids a dashboard ask', () => {
    const rid = seedReport('rep-elsewhere', 'cancelled');
    const askId = seedMessage({ id: 'ask-span', role: 'user', content: 'can you check the roof quote?' });
    seedToolCall({
      id: 'call-elsewhere', turnNumber: 44, phase: 'submit', reportId: rid,
      conversationId: 'conv-somewhere-else',
    });
    const answerId = seedMessage({ id: 'ans-span', role: 'assistant', content: 'It was 2,400.', turnNumber: 45 });
    db().prepare('UPDATE messages SET answer_message_id = ?, served_by_turn = 45 WHERE id = ?')
      .run(answerId, askId);

    expect(listedAskIds(), 'accepted collateral: the span arm is agent-scoped, not conversation-scoped')
      .toEqual([]);
  });
});
