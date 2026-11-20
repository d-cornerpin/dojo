// ════════════════════════════════════════════════════════════════════════════════════════
// AN INHERITED ASK CAN BE SETTLED, TWO HONEST WAYS (proof-fix-f review R3-1).
//
// The first boot of this build parks orphans an older version stranded as `blocked`: owed,
// not auto-served. Without a way out they stay owed for ever — in the OPEN WORK block and the
// daily brief — including the ones the agent then answered, which invites a second answer.
//
//   (a) A REAL answer delivered in the ask's OWN conversation after the park closes it, with the
//       usual exclusions (an engine ack, a tool chip, a start-ack) and no claiming-turn match:
//       the turn that claimed it is dead. The conversation-scoped read is the one the ledger
//       remediation already uses, shared, not copied.
//   (b) The agent may stand one down through the tracker door with ITS OWN reason, recorded as
//       its judgement — never as "cancelled by the user" — landing on `abandoned`.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-inherited-settle', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => undefined }) }));
vi.mock('../../tracker/pm-agent.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensurePMAgentRunning: () => undefined,
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage, insertMessageIfAbsent } from '../../memory/message-store.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../store.js';
import { reconcileOrphanedClaims } from '../orphaned-claims.js';
import { recordDelivery } from '../../agent/v2/deliveries.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';
import { FX, FXID } from '../../../../../deploy/checks/fixture-vocabulary.mjs';

const AGENT = FXID.n4;
const db = (): Database.Database => mockDb.current!;
const row = (m: string): { state: string; result_delivery_id: string | null } =>
  db().prepare('SELECT state, result_delivery_id FROM work WHERE id = ?').get(askIdForMessage(m)) as never;
const reasons = (m: string): string[] => (db().prepare(
  "SELECT json_extract(payload, '$.reason') AS r FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id",
).all(askIdForMessage(m)) as Array<{ r: string }>).map((x) => x.r);
const closeRequest = (args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> =>
  trackerHandlers['work_close_request:commitment']({ agentId: AGENT, args, toolCallId: 'tc-1', turnNumber: 60 } as never) as never;

/** An ask an older build stranded: its turn was closed `terminated` by a boot long ago. */
function inherited(m: string, content: string, conv: string, turn: number): void {
  insertMessage({
    id: m, agentId: AGENT, role: 'user', content, lane: 'owner', channel: 'dashboard', senderId: 'owner',
    authorized: true, conversationId: conv, inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as never);
  claimAsk(askIdForMessage(m), AGENT);
  stampClaimingTurn(askIdForMessage(m), turn);
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, root_kind, root_id, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, 'user', 'ask', ?, datetime('now', '-9 days'), datetime('now', '-9 days'), 'terminated', 0)`,
  ).run(AGENT, turn, m);
}

/** A delivery made by a later, live turn of this agent into `conv`. */
function deliverFromALiveTurn(conv: string, o: { tool?: string; messageId?: string } = {}): string | null {
  endTurnContext(AGENT);
  const t = openTurnContext(AGENT);
  t.turnNumber = 60;
  t.root = { kind: 'ask', id: 'm-later', sourceMessageId: 'm-later', conversationId: conv };
  const r = recordDelivery({ agentId: AGENT, tool: o.tool ?? 'dashboard', channel: 'dashboard', conversationId: conv, messageId: o.messageId ?? null, outcome: 'delivered' });
  endTurnContext(AGENT);
  return r.kind === 'applied' ? r.value.deliveryId : null;
}

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, '${FX.n4}', 'idle', '1970-01-01')`).run(AGENT);
  d.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-a', ?, 'dashboard', 'owner'), ('conv-b', ?, 'imessage', '+15550100')`).run(AGENT, AGENT);
  inherited('m-old', 'Can you find the warranty card for the dishwasher?', 'conv-a', 5);
  reconcileOrphanedClaims({ inheritedBacklog: true });
  expect(row('m-old').state).toBe('blocked');
});
afterEach(() => { endTurnContext(AGENT); mockDb.current?.close(); mockDb.current = null; });

describe('(a) nothing closes an inherited ask on its own (review R4-1): a reply is not an answer to THAT message', () => {
  it('an unrelated reply in the same conversation leaves it owed', () => {
    deliverFromALiveTurn('conv-a');
    expect(row('m-old').state).toBe('blocked');
  });

  it('the notice turn\'s own bubble closes nothing', () => {
    // The notice drives an engine turn whose reply bubble lands in the owner's dashboard conversation.
    endTurnContext(AGENT);
    const t = openTurnContext(AGENT);
    t.turnNumber = 61;
    t.root = { kind: 'engine', id: 'notice-row', sourceMessageId: 'notice-row', conversationId: null } as never;
    recordDelivery({ agentId: AGENT, tool: 'dashboard', channel: 'dashboard', conversationId: 'conv-a', outcome: 'delivered' });
    endTurnContext(AGENT);
    expect(row('m-old').state).toBe('blocked');
  });

  it('an engine relay, a failure notice or any engine-sent row closes nothing, and is no receipt for kept', async () => {
    for (const tool of ['a2a-join-relay', 'a2a-join-failed', 'a2a-join-late', 'engine-ack', 'alert', 'busy-ack', 'imessage-door']) {
      deliverFromALiveTurn('conv-a', { tool });
    }
    expect(row('m-old').state).toBe('blocked');
    const r = await closeRequest({ id: askIdForMessage('m-old'), disposition: 'kept' });
    expect(r.isError, 'an engine-sent row is not the agent answering').toBe(true);
    expect(row('m-old').state).toBe('blocked');
  });
});

describe('(a) the agent names it: kept closes it on the real delivery it can point at', () => {
  it('kept with no real delivery in its conversation since the park is refused, and it stays owed', async () => {
    const r = await closeRequest({ id: askIdForMessage('m-old'), disposition: 'kept' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/answer it in its own conversation, then call work_close_request/);
    expect(row('m-old').state).toBe('blocked');
  });

  it('kept after a real answer in its own conversation closes it, that delivery as its receipt', async () => {
    const id = deliverFromALiveTurn('conv-a');
    const r = await closeRequest({ id: askIdForMessage('m-old'), disposition: 'kept' });
    expect(r.isError).toBeFalsy();
    expect(row('m-old')).toEqual({ state: 'done', result_delivery_id: id });
  });

  it('a delivery in ANOTHER conversation is no receipt for it', async () => {
    deliverFromALiveTurn('conv-b');
    const r = await closeRequest({ id: askIdForMessage('m-old'), disposition: 'kept' });
    expect(r.isError).toBe(true);
    expect(row('m-old').state).toBe('blocked');
  });

  it('a tool-call chip is no receipt for it', async () => {
    insertMessageIfAbsent({ id: 'chip-1', agentId: AGENT, role: 'assistant', turnNumber: 60,
      content: JSON.stringify([{ type: 'tool_use', id: 'x', name: 'file_read', input: {} }]) } as never);
    deliverFromALiveTurn('conv-a', { messageId: 'chip-1' });
    const r = await closeRequest({ id: askIdForMessage('m-old'), disposition: 'kept' });
    expect(r.isError).toBe(true);
  });
});

describe('(b) the agent may stand it down with its own reason, recorded as its judgement', () => {
  it('dropped with a note lands on abandoned, the reason is the agent\'s judgement, never "cancelled by the user"', async () => {
    const r = await closeRequest({ id: askIdForMessage('m-old'), disposition: 'dropped', note: 'the warranty ran out last year; nothing to find' });
    expect(r.isError).toBeFalsy();
    expect(row('m-old').state).toBe('abandoned');
    const why = reasons('m-old').at(-1) ?? '';
    expect(why).toContain('the warranty ran out last year');
    expect(why).toMatch(/agent's judgement/);
    expect(why).not.toMatch(/cancelled by the user/);
    expect(r.content).not.toMatch(/cancelled by the user/);
  });

  it('dropped with no note is refused, asking for the agent\'s own reason', async () => {
    const r = await closeRequest({ id: askIdForMessage('m-old'), disposition: 'dropped' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/your own reason/i);
    expect(row('m-old').state).toBe('blocked');
  });

});

describe('the one notice names each ask and both ways to settle it', () => {
  it('lists each ask id, and names both ways: kept after answering, or dropped with a reason', () => {
    const n = (db().prepare("SELECT content FROM messages WHERE agent_id = ? AND origin_intent = 'owed_messages_inherited'").all(AGENT) as Array<{ content: string }>);
    expect(n).toHaveLength(1);
    expect(n[0].content).toContain(askIdForMessage('m-old'));
    expect(n[0].content).toMatch(/answer it in its own conversation, then call work_close_request\(<id>, kept\); or dropped with your reason/);
  });
});
