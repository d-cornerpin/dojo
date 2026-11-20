// The turn serves the first thing owed: an engine event rooted in the owner's request goes before a helper's result,
// and a person whose request waits for its own due time is not waiting at turn start (a settled-context wake).
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
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage, insertEngineEvent } from '../../../../../memory/message-store.js';
import { transition } from '../../../../../work/store.js';
import { runTurnTrigger } from '../turn-trigger.js';
import { runTurnClassification } from '../turn-classification.js';
import { nextOwed } from '../../../owed.js';
import type { PreflightContext, PreflightScratch } from '../index.js';
import type { TurnContext } from '../../../../turn-context.js';

const AGENT = 'worker';
const ctx = { agentId: AGENT, setAgentStatus: () => undefined, startStatusHeartbeat: () => undefined } as unknown as PreflightContext;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 40000, 1)`).run();
  mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Worker', 'm', 'idle', '{}', 'sensei')").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const ownerAsk = (id: string): string => insertMessage({
  id, agentId: AGENT, role: 'user', content: 'pull the quarterly numbers', lane: 'owner', channel: 'dashboard',
  senderId: 'owner', authorized: true, inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
} as never).id;

describe('the turn serves the first owed item', () => {
  it('an event rooted in the owner\'s request is served before a helper\'s result', async () => {
    const m = ownerAsk('m-owner');
    transition(`ask:${m}`, { to: 'claimed', by: 'agent', actorId: AGENT, claimedByTurn: 1, reason: 'pickup' });   // mid-work
    insertMessage({
      agentId: AGENT, role: 'user', lane: 'a2a', sourceAgentId: 'helper', a2aThreadId: 'thr-1',
      a2aIntent: 'DELIVERABLE', a2aRequiresResponse: true, content: '[A2A:DELIVERABLE thread:thr-1 from:Helper] the figures',
    });
    insertEngineEvent({ agentId: AGENT, content: 'the approval came back', originIntent: 'tracker', work: { taskId: null, runId: null, rootKind: 'ask', rootId: m } });
    const turnCtx = {} as unknown as TurnContext;
    const scratch: PreflightScratch = { claimedEngineEvent: null, pendingEngineClaim: null, terminalAnswerRowId: null };
    const out = await runTurnClassification(turnCtx, ctx, scratch, {
      db: mockDb.current!, waitingConvs: [], openHumanWorkAtTurnStart: false, item: nextOwed(AGENT)[0], triggerRow: null,
      chosenConvKey: '', lastUserMessageContent: '', unrepliedAssign: null,
    });
    if (out.directive !== 'proceed') throw new Error('expected proceed');
    expect(out.outputs.isEngineTurn).toBe(true);
    expect(out.outputs.isA2ATurn).toBe(false);
  });

  it('a person due now is waiting at turn start; one waiting for its own due time is not', () => {
    ownerAsk('m-later');
    mockDb.current!.prepare("UPDATE work SET next_attempt_at = ? WHERE kind = 'ask'").run(Date.now() + 60_000);
    const later = runTurnTrigger({} as unknown as TurnContext, ctx);
    if (later.directive !== 'proceed') throw new Error('expected proceed');
    expect(later.outputs.openHumanWorkAtTurnStart).toBe(false);
    expect(later.outputs.item).toBeUndefined();

    mockDb.current!.prepare("UPDATE work SET next_attempt_at = NULL WHERE kind = 'ask'").run();
    const now = runTurnTrigger({} as unknown as TurnContext, ctx);
    if (now.directive !== 'proceed') throw new Error('expected proceed');
    expect(now.outputs.openHumanWorkAtTurnStart).toBe(true);
    expect(now.outputs.item?.kind).toBe('person');
  });
});
