// ════════════════════════════════════════════════════════════════════════════════════════
// t158 D — THE START-ACK IS FOR A FRESH ASK, AND "FRESH" IS JUDGED PER ASK, NOT PER TURN.
//
// Ritual run 6 (S1 variant A): turn 2 acked "On it - starting at page 1…", hit the 75-round cap,
// the ask was re-opened, and turns 3 and 4 were picked up with the SAME ask as their trigger.
// `startAckRepliedNow` asks only "has an assistant text row landed THIS turn" and skips rows
// carrying an `origin_intent` (which the engine-delivered ack itself does), so each continuation
// armed a new timer and the owner read "Still grinding through the chain …" and "On it — and
// good news…" for one ask.
//
// The person has heard something when ANY user-visible assistant line landed for this ask since
// the ask's own row arrived, on any turn — the engine-delivered ack included. Read from the
// conversation's rows since the trigger row, not from `turn_number`.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage, START_ACK_ORIGIN_INTENT } from '../../../../../memory/message-store.js';
import { runStartAck } from '../start-ack.js';

const AGENT = 'harnessbot';
const CONV = 'conv-1';
const AFTER_MS = 30_000;

function seedAgent(): void {
  const db = mockDb.current!;
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'HarnessBot', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, AGENT);
}

function seed(): { askRowid: number } {
  seedAgent();
  return seedAsk();
}

function seedAsk(): { askRowid: number } {
  const askRowid = insertMessage({
    id: 'm-ask', agentId: AGENT, role: 'user', content: 'Audit all 600 pages and report back.',
    lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true, conversationId: CONV,
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as never).seq;
  return { askRowid };
}

/** An assistant line that landed on an earlier turn of the same ask. */
function earlierLine(turn: number, content: string, originIntent: string | null): void {
  insertMessage({
    id: `a-${turn}-${content.length}`, agentId: AGENT, role: 'assistant', content, turnNumber: turn,
    conversationId: CONV, ...(originIntent ? { originIntent } : {}),
  } as never);
}

function startTurn(askRowid: number, turnNumber: number) {
  const turnCtx = {
    anyToolStartedThisTurn: true, startAckTimer: null as ReturnType<typeof setTimeout> | null,
    startAckSteerRequested: false, startAckSteerArmedThisTurn: false, engineStartAckDeliveredThisTurn: false,
    state: { explicitSendThisTurn: {} },
  };
  const out = runStartAck(turnCtx as never, { agentId: AGENT, engineStartAckAfterMs: AFTER_MS } as never, {
    db: mockDb.current as never,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, senderIsAgent: false } as never,
    triggerRow: { rowid: askRowid, id: 'm-ask', conversation_id: CONV } as never,
    turnNumber,
  });
  return { turnCtx, out };
}

beforeEach(() => {
  vi.useFakeTimers();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
});
afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

describe('t158 D — the "On it" line is said once per ask', () => {
  it('a fresh ask still gets its one ack: the threshold passes with nothing heard, the steer is requested', () => {
    const { askRowid } = seed();
    const { turnCtx, out } = startTurn(askRowid, 2);
    expect(out.startAckArmed).toBe(true);
    vi.advanceTimersByTime(AFTER_MS + 1);
    expect(turnCtx.startAckSteerRequested).toBe(true);
  });

  it('a continuation of an ask whose engine-delivered ack already landed stays quiet: no timer, no steer, no first-tool ack', async () => {
    const { askRowid } = seed();
    earlierLine(2, 'On it - starting at page 1…', START_ACK_ORIGIN_INTENT);
    const { turnCtx, out } = startTurn(askRowid, 3);
    expect(out.startAckArmed, 'nothing left to say on this ask').toBe(false);
    vi.advanceTimersByTime(AFTER_MS * 3);
    expect(turnCtx.startAckSteerRequested).toBe(false);
    await out.fireStartAckIfOwed('first-tool');
    expect(turnCtx.startAckSteerRequested).toBe(false);
    expect(turnCtx.startAckTimer).toBeNull();
  });

  it('the line that was heard need not be the ack: any visible assistant text on an earlier turn of this ask counts', () => {
    const { askRowid } = seed();
    earlierLine(2, 'Still grinding through the chain — 85 pages audited so far.', null);
    const { turnCtx } = startTurn(askRowid, 4);
    vi.advanceTimersByTime(AFTER_MS + 1);
    expect(turnCtx.startAckSteerRequested).toBe(false);
  });

  it('a line from BEFORE the ask arrived is not something the person heard about it', () => {
    seedAgent();
    earlierLine(1, 'An answer to an earlier question.', null);
    const { askRowid } = seedAsk();
    const { turnCtx } = startTurn(askRowid, 2);
    vi.advanceTimersByTime(AFTER_MS + 1);
    expect(turnCtx.startAckSteerRequested).toBe(true);
  });

  it('tool-call rows are not words the person heard', () => {
    const { askRowid } = seed();
    earlierLine(2, '[{"type":"tool_use","id":"t1","name":"file_read","input":{}}]', null);
    const { turnCtx } = startTurn(askRowid, 3);
    vi.advanceTimersByTime(AFTER_MS + 1);
    expect(turnCtx.startAckSteerRequested).toBe(true);
  });
});
