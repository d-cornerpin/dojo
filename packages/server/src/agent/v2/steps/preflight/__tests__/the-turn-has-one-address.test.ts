// The turn's address is computed ONCE in preflight, stored on the turn's bag, read from the request row on a
// job's own turn, and seeded into the state, so delivery and every note read one value.
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000 }); // the first clause pays the one-time module-graph load
import Database from 'better-sqlite3';

const { mockDb } = vi.hoisted(() => ({ mockDb: { current: null as Database.Database | null } }));
vi.mock('../../../../../db/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../db/connection.js')>('../../../../../db/connection.js');
  return { ...actual, getDb: () => { if (!mockDb.current) throw new Error('no db'); return mockDb.current; } };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../../../../db/migrations.js';
import { openTurnContext, endTurnContext, type TurnContext } from '../../../../turn-context.js';
import { runCounterpartyAndRecord, type CounterpartyAndRecordInputs } from '../counterparty-and-record.js';
import type { PreflightContext, PreflightScratch } from '../index.js';

const AGENT = 'primary';
let turnCtx: TurnContext;

beforeEach(() => {
  mockDb.current?.close();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Primary', 'm', 'idle', '{}', 'sensei')`).run(AGENT);
  endTurnContext(AGENT);
  turnCtx = openTurnContext(AGENT);
});

const sc = {} as PreflightScratch;
const pctx = { agentId: AGENT } as unknown as PreflightContext;

function inputs(over: Partial<CounterpartyAndRecordInputs>): CounterpartyAndRecordInputs {
  return {
    isHumanContinuation: false, jobRow: undefined, a2aCounterpartyIdentity: null,
    lastUserMessageContent: 'hello', lastUserMessageId: null, triggerRow: null, triggerWorkId: null,
    chosenConvKey: 'conv-x', inboundChannel: null, inboundContext: null, latestUserSource: null,
    triggeredByIMessage: false, isA2ATurn: false, isEngineTurn: false, terminalWakeA2A: null,
    terminalWakeDrivesTurn: false, pendingEngineEvent: null, a2aReplyContext: null, contextWindow: 200000,
    isAutoRouted: false, configuredModelId: 'm-1', notificationTriggerRowid: null, ...over,
  } as CounterpartyAndRecordInputs;
}

const contactRow = {
  rowid: 1, lane: 'owner', channel: 'imessage', content: 'hi',
  inbound_meta: JSON.stringify({ channel: 'imessage', relation: 'known_contact', sender: '+15550100', senderName: 'Pat Example', authorized: true }),
} as unknown as CounterpartyAndRecordInputs['triggerRow'];

describe('preflight stores one address for the turn', () => {
  it('a contact\'s iMessage turn: the address names the contact and iMessage, and the state is seeded from it', async () => {
    await runCounterpartyAndRecord(turnCtx, pctx, sc, inputs({ triggerRow: contactRow, inboundChannel: 'imessage' }));
    expect(turnCtx.address?.name).toBe('+15550100'); // a contact with no saved name is named by their address
    expect(turnCtx.address?.deliveryChannel).toBe('imessage');
    expect(turnCtx.address?.kind).toBe('person');
    expect(turnCtx.state?.inboundChannel).toBe('imessage');
  });

  it('a job\'s own turn is addressed from its request row, including the reply context, and the state is seeded from it', async () => {
    // The inbound channel and context are the ones `inbound-and-abort.ts` resolves from that same row.
    const next = openTurnContext(AGENT);
    await runCounterpartyAndRecord(next, pctx, sc, inputs({
      isHumanContinuation: true, jobRow: contactRow, lastUserMessageContent: null as never,
      triggerRow: null, inboundChannel: 'teams', inboundContext: { chatId: 'chat-1' },
    }));
    expect(next.address?.name).toBe('+15550100');
    expect(next.address?.deliveryChannel).toBe('teams');
    expect(next.address?.inboundContext).toEqual({ chatId: 'chat-1' });
    expect(next.state?.inboundChannel).toBe('teams');
    expect(next.state?.inboundContext).toEqual({ chatId: 'chat-1' });
  });

  it('an A2A turn and an engine turn have an address that names no person', async () => {
    await runCounterpartyAndRecord(turnCtx, pctx, sc, inputs({ isA2ATurn: true, a2aCounterpartyIdentity: { intent: 'QUESTION', threadShort: 't1', fromName: 'peer-agent' } }));
    expect(turnCtx.address?.kind).toBe('agent');
    expect(turnCtx.address?.routed).toBe(false);
    endTurnContext(AGENT);
    const e = openTurnContext(AGENT);
    await runCounterpartyAndRecord(e, pctx, sc, inputs({ isEngineTurn: true, chosenConvKey: '' }));
    expect(e.address?.kind).toBe('engine');
  });
});
