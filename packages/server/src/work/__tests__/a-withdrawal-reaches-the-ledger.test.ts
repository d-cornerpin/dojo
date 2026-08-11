// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 7.5 T32 — A WITHDRAWAL REACHES THE LEDGER.
//
// THE LEDGER, round-7 S6, verified by W11 and re-read at HEAD:
//   00:40:38  ask:32b16a5c "Compare budget noise-cancelling earbuds…" → claimed, turn 4679
//   00:40:58  user: "Never mind, forget the earbuds — just tell me one good podcast…"
//   00:41:05  turn 4679 delivers the full 1,900-char earbuds comparison — SEVEN SECONDS LATER
//   00:41:05  ask:32b16a5c → done, "delivered via dashboard", receipt 4d5e4ae3
//   SELECT COUNT(*) FROM work_events WHERE payload LIKE '%never mind%' … → 0
//
// TWO CAUSES, ONE PER LEG.
//
// B1 — the arrival could not reach the turn in time. `runOwedInterrupt` is the only step that
// points at a mid-turn arrival, it lives in the turn-ending floor family (reached only when the
// model called NO tools), and its gate additionally required a reply to already exist. On a
// research turn every pass but the last rides tool calls, so the step first ran on the pass that
// had already written the answer nobody wanted. The gate splits (steer early, RECORD still only
// once a reply exists — T25's high water is taken at write time, so moving it would hand the
// turn's own answer the right to close an ask it never addressed), and the step gains a second
// call site on tool-riding passes, which is what makes the in-flight arm live rather than
// theoretical. It must NOT take the loop there: the tool calls have not run yet.
//
// B2 — there was no door. `work_close_request(action="commitment")` reaches asks (asks and
// commitments share one obligation frame and one OPEN WORK block) and SWEEP-A TB1 fenced them
// out entirely, because a model was measured closing an owner's ask as "commitment kept". That
// refusal answers "may the model mark an ask ANSWERED" — still NO — but it also refused the one
// shape where nobody will ever answer it: the user called it off. The `dropped` disposition is
// admitted for asks, lands on T18's `abandoned` terminal (a user's choice is not a failure), and
// REQUIRES the note, because the user's words are the whole point of the leg. No tool surface
// changes: the tool's own description already says *"Use disposition 'dropped' when the person
// told you to forget it or it no longer applies."*
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t32-withdrawal', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => undefined }) }));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => undefined }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => undefined }));
vi.mock('../../tracker/pm-agent.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensurePMAgentRunning: () => undefined,
  noteTransitionForReview: () => undefined,
}));

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { askIdForMessage, claimAsk, stampClaimingTurn, openCommitment } from '../store.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';

const AGENT = 'kevin';
const CONV = 'conv-1';
const db = (): Database.Database => mockDb.current!;
const here = path.dirname(url.fileURLToPath(import.meta.url));
const sourceOf = (rel: string): string => fs.readFileSync(path.resolve(here, rel), 'utf8');

const call = (args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> =>
  trackerHandlers['work_close_request:commitment']({
    agentId: AGENT, args, toolCallId: 'tc-1', turnNumber: 1,
  } as never) as Promise<{ content: string; isError?: boolean }>;

function ownerAsk(messageId: string, content: string, o: { claimed?: boolean } = {}): string {
  insertMessage({
    id: messageId, agentId: AGENT, role: 'user', content,
    lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
    conversationId: CONV, inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as never);
  const id = askIdForMessage(messageId);
  if (o.claimed) { claimAsk(id, AGENT); stampClaimingTurn(id, 4679); }
  return id;
}

const row = (id: string): { state: string; kind: string } =>
  db().prepare('SELECT state, kind FROM work WHERE id = ?').get(id) as { state: string; kind: string };

const events = (id: string): Array<{ kind: string; payload: string }> => db().prepare(
  'SELECT kind, payload FROM work_events WHERE work_id = ? ORDER BY id',
).all(id) as Array<{ kind: string; payload: string }>;

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`).run(AGENT);
  d.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-1', ?, 'dashboard', 'owner')`).run(AGENT);
});

// ════════════════════════════════════════════════════════════════════
// §1 — LEG B2: THE WITHDRAWAL DOOR
// ════════════════════════════════════════════════════════════════════

describe('§1 an ask the user called off settles `abandoned`, with their words', () => {
  it('RED-turned-GREEN: dropped on an open ask lands the spine\'s user-choice terminal', async () => {
    const askId = ownerAsk('m-earbuds', 'Compare budget noise-cancelling earbuds for flights');
    const res = await call({ id: askId, disposition: 'dropped', note: 'Never mind, forget the earbuds' });
    expect(res.isError).toBeFalsy();
    expect(row(askId).state).toBe('abandoned');
    expect(res.content).toContain('cancelled by the user, not answered');
  });

  it('the USER\'S WORDS reach the ledger — the count that was zero', async () => {
    const askId = ownerAsk('m-earbuds', 'Compare budget noise-cancelling earbuds for flights');
    await call({ id: askId, disposition: 'dropped', note: 'Never mind, forget the earbuds' });
    const payloads = events(askId).map((e) => e.payload).join(' ');
    expect(payloads).toContain('Never mind, forget the earbuds');
    expect(payloads).toContain('cancelled by the user');
  });

  it('it works on an ask a turn is still holding — the in-flight shape', async () => {
    const askId = ownerAsk('m-earbuds', 'Compare budget noise-cancelling earbuds', { claimed: true });
    expect(row(askId).state).toBe('claimed');
    const res = await call({ id: askId, disposition: 'dropped', note: 'forget the earbuds' });
    expect(res.isError).toBeFalsy();
    expect(row(askId).state).toBe('abandoned');
  });

  it('NOT `done` and NOT `failed`: a user\'s choice is neither answered nor a failure', async () => {
    const askId = ownerAsk('m-earbuds', 'Compare earbuds');
    await call({ id: askId, disposition: 'dropped', note: 'never mind' });
    expect(row(askId).state).not.toBe('done');
    expect(row(askId).state).not.toBe('failed');
  });

  it('a withdrawal with no note is REFUSED — a reason that is not the user\'s words is a guess', async () => {
    const askId = ownerAsk('m-earbuds', 'Compare earbuds');
    const res = await call({ id: askId, disposition: 'dropped' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('what the user actually said');
    expect(row(askId).state).toBe('open');
  });

  it('CONTROL — the TB1 refusal is intact and total for `kept`: the model may not mark an ask answered', async () => {
    const askId = ownerAsk('m-earbuds', 'Compare earbuds');
    const res = await call({ id: askId, disposition: 'kept', note: 'I answered it' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('is something the owner asked YOU for');
    expect(res.content).toContain('It closes itself the moment an answer is delivered');
    expect(row(askId).state).toBe('open');
  });

  it('and that refusal now POINTS at the door, so a model that was told "no" knows the other word', async () => {
    const askId = ownerAsk('m-earbuds', 'Compare earbuds');
    const res = await call({ id: askId, disposition: 'kept' });
    expect(res.content).toContain('disposition "dropped"');
  });

  it('CONTROL — a real COMMITMENT still drops exactly as before, reason unprefixed', async () => {
    const cmtId = openCommitment({
      agentId: AGENT, description: 'email Bob the roof quote', conversationId: CONV,
      turnNumber: 1, sourceMessageId: null,
    } as never) as unknown as string;
    const res = await call({ id: cmtId, disposition: 'dropped', note: 'Bob went with someone else' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe('[OK] Dropped: email Bob the roof quote.');
    expect(row(cmtId).state).toBe('abandoned');
    expect(events(cmtId).map((e) => e.payload).join(' ')).not.toContain('cancelled by the user');
  });

  it('CONTROL — an unknown id is still the same steerable refusal', async () => {
    const res = await call({ id: 'cmt:deadbeefdeadbeef', disposition: 'dropped', note: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('no open work matches');
  });

  it('NO TOOL SURFACE MOVED: the door and the vocabulary were already advertised', () => {
    const defs = sourceOf('../../agent/tools/definitions.ts');
    expect(defs).toContain('Use disposition "dropped" when the person told you to forget it or it no longer applies.');
  });
});

// ════════════════════════════════════════════════════════════════════
// §2 — LEG B1: THE STEER STOPS WAITING FOR A REPLY, AND THE RECORD DOES NOT MOVE WITH IT
// ════════════════════════════════════════════════════════════════════

describe('§2 the owed-interrupt gate splits, and T25\'s high water stays put', () => {
  const step = (): string => sourceOf('../../agent/v2/steps/post-call-classify/owed-interrupt.ts');

  it('the gate no longer requires a reply to exist', () => {
    const src = step();
    const at = src.indexOf('  if (\n    counterparty.kind === \'user\' &&');
    expect(at).toBeGreaterThan(-1);
    const gate = src.slice(at, src.indexOf('\n  ) {', at));
    expect(gate).not.toContain('persistedContent && persistedContent.trim().length > 0');
    expect(gate).toContain('(maySteer || mayRecord)');
  });

  it('`maySteer` carries the bound and the latch, and nothing about a reply', () => {
    const src = step();
    const decl = src.slice(src.indexOf('const maySteer ='), src.indexOf(';', src.indexOf('const maySteer =')));
    expect(decl).toContain("steerFired(state.steerQueue, 'owed-interrupt')");
    expect(decl).toContain('state.loopCount < MAX_TOOL_LOOPS');
    expect(decl).not.toContain('persistedContent');
    expect(decl).not.toContain('hasReply');
  });

  it('`mayRecord` requires a reply AND the once-per-turn latch — this is the T25 guarantee', () => {
    const src = step();
    const decl = src.slice(src.indexOf('const mayRecord ='), src.indexOf(';', src.indexOf('const mayRecord =')));
    expect(decl).toContain('hasReply');
    expect(decl).toContain('!state.owedInterruptSubjectsRecorded');
    const call = src.indexOf('recordOwedInterruptSubjects(agentId');
    expect(src.slice(0, call).lastIndexOf('if (mayRecord) {')).toBeGreaterThan(
      src.slice(0, call).lastIndexOf('if (maySteer)'));
    expect((src.match(/recordOwedInterruptSubjects\(agentId/g) ?? []).length).toBe(1);
    expect(src).toContain('advance(state, { owedInterruptSubjectsRecorded: true })');
  });

  it('the latch is declared on the turn state and initialised false', () => {
    const st = sourceOf('../../agent/v2/state.ts');
    expect(st).toContain('owedInterruptSubjectsRecorded: boolean;');
    expect(st).toContain('owedInterruptSubjectsRecorded: false,');
  });

  it('a pass that may only RECORD does not also steer', () => {
    expect(step()).toContain('if (!maySteer) return proceed(state);');
  });

  it('STILL ONE STEER PER TURN AND ONE ENQUEUE SITE — bounded by the code, not by care', () => {
    const src = step();
    expect((src.match(/enqueueSteer\(/g) ?? []).length).toBe(1);
    expect(src).toContain('state.loopCount < MAX_TOOL_LOOPS');
  });
});

describe('§3 the in-flight arm is LIVE, and it never eats the turn\'s tool calls', () => {
  it('the step is called on tool-riding passes too — the reason B1 was inert before', () => {
    const idx = sourceOf('../../agent/v2/steps/post-call-classify/index.ts');
    expect(idx).toContain('import { runOwedInterrupt }');
    expect(idx).toContain('const owedInFlight = await runOwedInterrupt(state, ctx, sc);');
    // in the ELSE of the no-tool-calls branch, i.e. exactly the tool-riding passes
    const elseAt = idx.indexOf('} else {', idx.indexOf('if (result.toolCalls.length === 0) {'));
    expect(elseAt).toBeGreaterThan(-1);
    expect(idx.indexOf('const owedInFlight')).toBeGreaterThan(elseAt);
  });

  it('and it returns `proceed` on that path, so `execute` still runs the calls', () => {
    const src = sourceOf('../../agent/v2/steps/post-call-classify/owed-interrupt.ts');
    expect(src).toContain('const ridingToolCalls = ctx.result.toolCalls.length > 0;');
    expect(src).toContain('return ridingToolCalls ? proceed(state) : continueLoop(state);');
  });

  it('the in-flight steer asks the model to stop its OWN work, never to answer the arrival', () => {
    const src = sourceOf('../../agent/v2/steps/post-call-classify/owed-interrupt.ts');
    const body = src.slice(src.indexOf('const inFlightPrompt = ('), src.indexOf('\n      );', src.indexOf('const inFlightPrompt = (')));
    expect(body).toContain('Do NOT answer ${itThem} in this turn');
    expect(body).toContain('${laterTurnRelease}');
    expect(body).toContain('if it cancels or replaces that work, STOP');
    expect(body).toContain('do not deliver the cancelled task\'s answer as though they had not spoken');
    expect(body).not.toContain('Reply ONLY to');
  });

  it('it names the B2 door and the note, so the ledger gets the user\'s words', () => {
    const src = sourceOf('../../agent/v2/steps/post-call-classify/owed-interrupt.ts');
    const body = src.slice(src.indexOf('const inFlightPrompt = ('), src.indexOf('\n      );', src.indexOf('const inFlightPrompt = (')));
    expect(body).toContain('work_close_request(action="commitment", disposition="dropped"');
    expect(body).toContain("note=\"<the user's own words>\"");
    // the id is SUPPLIED: the serving ask is `claimed` and so is absent from the OPEN WORK block
    expect(src).toContain("const servingAskId = turnCtx.root?.kind === 'ask'");
    expect(body).toContain('id="${servingAskId}"');
  });

  it('the in-flight form is chosen exactly when nothing has been delivered', () => {
    expect(sourceOf('../../agent/v2/steps/post-call-classify/owed-interrupt.ts'))
      .toContain('const rePrompt = hasReply ? afterReplyPrompt : inFlightPrompt;');
  });

  it('T31\'s hold is not weakened: an in-flight grant is still marked afterReply:false', () => {
    const src = sourceOf('../../agent/v2/steps/post-call-classify/owed-interrupt.ts');
    expect(src).toContain('afterReply: hasReply,');
  });
});
