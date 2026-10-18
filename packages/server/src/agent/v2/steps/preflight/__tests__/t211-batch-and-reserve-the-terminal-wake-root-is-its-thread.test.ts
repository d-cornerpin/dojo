// ════════════════════════════════════════════════════════════════════════════════════════
// t211 (t207 hand-up 1) — A TERMINAL-WAKE TURN'S ROOT IS ITS THREAD.
//
// The classification meant to set `root = { kind: 'a2a', id: <thread> }` for a turn woken by a peer's
// deliverable, but read `a2a_thread_id` off an object whose field is `threadId`, so the root was never set.
// Readers of the root (the row label, the reply-thread stamp, the receipts and the destructive-gate audit)
// then saw "no root" for every terminal-wake turn.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  setLogLevel: vi.fn(), setLogBroadcast: vi.fn(), readLogEntries: () => [],
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { openTurnContext, endTurnContext } from '../../../../../agent/turn-context.js';
import { trackerHandlers } from '../../../../../agent/tools/cat/tracker.js';
import { runTurnClassification } from '../turn-classification.js';
import type { PreflightContext, PreflightScratch } from '../index.js';
import type { TurnContext } from '../../../../../agent/turn-context.js';

const AGENT = 'worker';
const PEER = 'helper';
const THREAD = 'f00dcafe-1111-2222-3333-444455556666';

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 40000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Worker', 'm', 'idle', '{}', 'sensei')").run(AGENT);
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Helper', 'm', 'idle', '{}', 'sensei')").run(PEER);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const preflightCtx = (): PreflightContext => ({
  agentId: AGENT,
  startStatusHeartbeat: () => undefined,
  stopStatusHeartbeat: () => undefined,
  detectTaskThrashing: () => ({ thrashing: false }),
  engineBlockEscapeHatch: '',
  engineStartAckAfterMs: 0,
} as unknown as PreflightContext);

async function classify(): Promise<TurnContext> {
  const turnCtx = {} as unknown as TurnContext;
  const scratch: PreflightScratch = { claimedEngineEvent: null, pendingEngineClaim: null, terminalAnswerRowId: null };
  const out = await runTurnClassification(turnCtx, preflightCtx(), scratch, {
    db: mockDb.current!, waitingConvs: [], openHumanWorkAtTurnStart: false, triggerRow: null,
    chosenConvKey: '', lastUserMessageContent: '', unrepliedAssign: null,
  });
  if (out.directive !== 'proceed') throw new Error(`expected proceed, got ${out.reason}`);
  return turnCtx;
}

describe('t211 hand-up 1 — the terminal-wake root is set', () => {
  it('a peer\'s terminal deliverable makes the turn\'s root its (full) thread', async () => {
    insertMessage({
      id: 'wake-row', agentId: AGENT, role: 'user', lane: 'a2a', content: '[A2A:DELIVERABLE thread:f00dcafe from:Helper] Here is the audited ledger.',
      sourceAgentId: PEER, a2aThreadId: THREAD, a2aIntent: 'DELIVERABLE', a2aRequiresResponse: true,
    });
    const turnCtx = await classify();
    expect(turnCtx.root).toEqual({ kind: 'a2a', id: THREAD, sourceMessageId: null });
  });
});

describe('t211 hand-up 1 audit — a reader of the root asks for the field it means', () => {
  it('a commitment promised in a thread-rooted turn does not record the THREAD id as a message id', async () => {
    const bag = openTurnContext(AGENT);
    bag.turnNumber = 3;
    bag.root = { kind: 'a2a', id: THREAD, sourceMessageId: null };
    try {
      const out = await trackerHandlers['work_open:commitment']({
        agentId: AGENT, args: { description: 'send the corrected ledger' },
      } as never);
      expect(out.isError).toBeFalsy();
      const row = mockDb.current!.prepare("SELECT root_id FROM work WHERE kind = 'commitment' AND agent_id = ?").get(AGENT) as { root_id: string };
      expect(row.root_id, 'a thread id is not a message id').toBe('turn:3');
    } finally { endTurnContext(AGENT); }
  });
});
