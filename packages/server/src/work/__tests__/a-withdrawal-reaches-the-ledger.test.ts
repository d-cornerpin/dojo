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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t32-withdrawal', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => undefined }) }));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => undefined }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => undefined }));
vi.mock('../../tracker/pm-agent.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensurePMAgentRunning: () => undefined,
}));
import path from 'node:path';
import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { askIdForMessage, claimAsk, stampClaimingTurn, openCommitment } from '../store.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const CONV = 'conv-1';
const db = (): Database.Database => mockDb.current!;

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
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, '${FX.n4}', 'idle', '1970-01-01')`).run(AGENT);
  d.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-1', ?, 'dashboard', 'owner')`).run(AGENT);
});

// ════════════════════════════════════════════════════════════════════
// §1 — LEG B2: THE WITHDRAWAL DOOR
// ════════════════════════════════════════════════════════════════════

describe('§1 an ask the user called off settles `abandoned`, with their words', () => {
  it('RED-turned-GREEN: dropped on an open ask lands the spine\'s user-choice terminal', async () => {
    const askId = ownerAsk('m-earbuds', 'Compare budget noise-cancelling earbuds for flights');
    ownerAsk('m-off', 'Never mind, forget the earbuds');
    const res = await call({ id: askId, disposition: 'dropped', note: 'Never mind, forget the earbuds' });
    expect(res.isError).toBeFalsy();
    expect(row(askId).state).toBe('abandoned');
    expect(res.content).toContain('cancelled by the user, not answered');
  });

  it('the USER\'S WORDS reach the ledger — the count that was zero', async () => {
    const askId = ownerAsk('m-earbuds', 'Compare budget noise-cancelling earbuds for flights');
    ownerAsk('m-off', 'Never mind, forget the earbuds');
    await call({ id: askId, disposition: 'dropped', note: 'Never mind, forget the earbuds' });
    const payloads = events(askId).map((e) => e.payload).join(' ');
    expect(payloads).toContain('Never mind, forget the earbuds');
    expect(payloads).toContain('cancelled by the user');
  });

  it('it works on an ask a turn is still holding — the in-flight shape', async () => {
    const askId = ownerAsk('m-earbuds', 'Compare budget noise-cancelling earbuds', { claimed: true });
    ownerAsk('m-off', 'forget the earbuds');
    expect(row(askId).state).toBe('claimed');
    const res = await call({ id: askId, disposition: 'dropped', note: 'forget the earbuds' });
    expect(res.isError).toBeFalsy();
    expect(row(askId).state).toBe('abandoned');
  });

  it('NOT `done` and NOT `failed`: a user\'s choice is neither answered nor a failure', async () => {
    const askId = ownerAsk('m-earbuds', 'Compare earbuds');
    ownerAsk('m-off', 'never mind');
    await call({ id: askId, disposition: 'dropped', note: 'never mind' });
    expect(row(askId).state).not.toBe('done');
    expect(row(askId).state).not.toBe('failed');
  });

  it('a withdrawal with no note is REFUSED — a reason that is not the user\'s words is a guess', async () => {
    const askId = ownerAsk('m-earbuds', 'Compare earbuds');
    const res = await call({ id: askId, disposition: 'dropped' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('what the person you are talking to actually said');
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
});
