// A helper agent asked by other agents, on a database run through the real migrations: requests go through the
// real transport, replies land in the asker's store, and turns run through the real preflight and finalize.
// Mocks in each file:
//
//   vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
//   vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
//   vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));
import Database from 'better-sqlite3';
import { vi } from 'vitest';

// The product modules load on first use, after the calling file's mocks are in place.
const product = async () => ({
  ...await import('../../../memory/message-store.js'), ...await import('../../../work/store.js'),
  ...await import('../../a2a-transport.js'), ...await import('../../turn-context.js'),
  ...await import('../../v2/steps/preflight/index.js'), ...await import('../../v2/steps/teardown/finalize-record.js'),
  ...await import('../../v2/engine-exit.js'), ...await import('../../v2/state.js'),
});

export const HELPER = 'helper';
export const ASKER = 'asker-one';
export const ASKER2 = 'asker-two';

const state: { db: Database.Database | null } = { db: null };
export const testDb = (): Database.Database => {
  if (!state.db) throw new Error('agent-requests: test DB not initialized');
  return state.db;
};
export const connectionMock = () => ({ getDb: testDb, closeDb: () => {}, getDbPath: () => ':memory:' });

/** A fresh database with a model and three agents. */
export function freshAgentsDb(runMigrations: () => void): void {
  state.db?.close();
  state.db = new Database(':memory:');
  runMigrations();
  const db = testDb();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  for (const [id, name] of [[HELPER, 'Helper'], [ASKER, 'Asker One'], [ASKER2, 'Asker Two']]) {
    db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification, session_started_at)
      VALUES (?, ?, 'm', 'idle', '{}', 'apprentice', '1970-01-01')`).run(id, name);
  }
}

/** The preflight's own inputs, with the status writers faked. */
export const preflightCtx = (agentId = HELPER) => ({
  agentId, setAgentStatus: vi.fn(), startStatusHeartbeat: vi.fn(), stopStatusHeartbeat: vi.fn(), engineStartAckAfterMs: 30_000,
});

/** A reply from `from` on `threadId`, as the transport lands it in the asker's store. */
export async function replyLands(from: string, asker: string, threadId: string): Promise<void> {
  const { insertMessage } = await product();
  insertMessage({
    agentId: asker, role: 'user', lane: 'a2a', sourceAgentId: from, a2aThreadId: threadId, a2aIntent: 'ANSWER',
    a2aRequiresResponse: true, content: `[A2A:ANSWER thread:${threadId.slice(0, 8)} from:${from}] here it is`,
  });
}

/** The asker delegates its owner's request to the helper on `threadId` (a real send, and the asker's join). */
export async function askerDelegates(intent: 'QUESTION' | 'ASSIGN', threadId: string): Promise<string> {
  const { insertMessage, askIdForMessage, claimAsk, deliverA2AMessage, openDelegationJoin } = await product();
  insertMessage({ id: 'owner-ask', agentId: ASKER, role: 'user', content: 'find out for me', lane: 'owner', channel: 'dashboard', senderId: 'owner' });
  const ask = askIdForMessage('owner-ask');   // the owner's message opened its ask
  claimAsk(ask, ASKER);
  const sent = await deliverA2AMessage({ intent, threadId, requiresResponse: true, payload: 'the figure, please', toAgent: HELPER, fromAgent: ASKER });
  if (!sent.delivered) throw new Error('agent-requests: the request was not delivered');
  openDelegationJoin({
    parentWorkId: ask, agentId: ASKER, replyConversationId: null, ttlAt: Date.now() + 60 * 60_000,
    threads: [{ threadId, assigneeAgent: HELPER, intent, hopCount: 0 }],
  });
  return ask;
}

export const pieceState = (ask: string): string | undefined => (testDb().prepare(
  'SELECT state FROM work WHERE parent_id = ? ORDER BY opened_at LIMIT 1').get(ask) as { state: string } | undefined)?.state;

/** One helper turn through the real preflight; then finalize as the turn ended: silent, a rate limit on its first
 *  call (waiting for `reset`), or a crash (no finalize). Returns the request the turn served; null when it served
 *  none or the preflight ended the turn. */
export async function helperTurn(end: 'silent' | 'limit' | 'crash' = 'silent', reset = 0): Promise<string | null> {
  const { openTurnContext, endTurnContext, runPreflight, finalizeTurnRecord, latchEngineCut, advance } = await product();
  endTurnContext(HELPER);
  const bag = openTurnContext(HELPER);
  const out = await runPreflight(bag, preflightCtx());
  if (out.directive !== 'proceed') { endTurnContext(HELPER); return null; }
  const served = bag.kind === 'a2a' ? (bag.servedRequest?.messageId ?? null) : null;
  if (end !== 'crash') {
    let state = bag.state!;
    if (end === 'limit') { bag.retryAt = reset; state = advance(latchEngineCut(state, 'provider_error'), { loopCount: 1 }); }
    await finalizeTurnRecord(state, out.outputs.teardownContext());
  }
  endTurnContext(HELPER);
  return served;
}

export const requestRow = (threadId: string) => testDb().prepare(
  `SELECT served_by_turn AS served, swept_at AS swept, delivery_attempts AS attempts, next_attempt_at AS due
     FROM messages WHERE agent_id = ? AND a2a_thread_id = ? AND role = 'user'`,
).get(HELPER, threadId) as { served: number | null; swept: number | null; attempts: number; due: number | null };
