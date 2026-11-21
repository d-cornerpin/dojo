// 3.5 Task 7: an offline replay of the shape GitHub #28 reported. A contact texts the primary agent
// over iMessage; the job needs the owner told; the owner's dashboard line is the NEWEST row in the
// database, so the old tag said "dashboard chat" while delivery went to the contact. Everything the
// agent reads and everything the engine does about it is driven here without a model and without a
// channel, and each step is asserted against the one fact: this turn is talking to the contact.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 60_000 });
const { mockDb } = vi.hoisted(() => ({ mockDb: { current: null as Database.Database | null } }));
vi.mock('../../../db/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../../../db/connection.js')>('../../../db/connection.js');
  return { ...actual, getDb: () => { if (!mockDb.current) throw new Error('no db'); return mockDb.current; } };
});
vi.mock('../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isPrimaryAgent: vi.fn(() => true), isPMAgent: vi.fn(() => false), getOwnerName: vi.fn(() => 'Owner Example'),
}));
vi.mock('../../../services/capabilities.js', () => ({ getModelCapabilities: vi.fn(() => []) }));
vi.mock('../../../router/router-window.js', () => ({ agentTurnWindow: vi.fn(() => 200000) }));
// The NEWEST user row of any conversation is the owner's dashboard line: the trap of #28.
vi.mock('../../../prompt/assembler.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveInboundContext: vi.fn(() => ({ inboundChannel: 'dashboard', smsFromNumber: null, phoneFromNumber: null, replyDestination: 'dashboard', lastContent: 'owner: please tell the contact thanks' })),
  resolveTtsEngine: vi.fn(() => 'local'),
}));

import { runMigrations } from '../../../db/migrations.js';
import { openTurnContext, endTurnContext } from '../../turn-context.js';
import { runCounterpartyAndRecord, type CounterpartyAndRecordInputs } from '../steps/preflight/counterparty-and-record.js';
import type { PreflightContext, PreflightScratch } from '../steps/preflight/index.js';
import { buildAssemblyContext } from '../../../prompt/registry/assembler.js';
import { getMessageEntries } from '../../../prompt/registry/registry.js';
import '../../../prompt/registry/entries.js';
import { resolveDeliveryChannel } from '../turn-address.js';
import { refuseSendWithNoRecipient, recipientNoteFor } from '../send-recipient.js';
import { appendOnlyTurn } from '../steps/call-llm/append-only-turn.js';
import { tagMessageLane } from '../../../memory/message-lane-tag.js';

const AGENT = 'primary';
const OWNER_ADDRESS = '+15550199';
const CONTACT_ADDRESS = '+15550100';

beforeEach(() => {
  mockDb.current?.close();
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Primary', 'm', 'idle', '{}', 'sensei')`).run(AGENT);
  endTurnContext(AGENT);
});

const contactRow = {
  rowid: 1, lane: 'owner', channel: 'imessage', content: 'Can you check on the thing for me?',
  inbound_meta: JSON.stringify({ channel: 'imessage', relation: 'known_contact', sender: CONTACT_ADDRESS, senderName: 'Pat Example', authorized: true }),
} as unknown as CounterpartyAndRecordInputs['triggerRow'];

const inputs = (): CounterpartyAndRecordInputs => ({
  isHumanContinuation: false, continuation: undefined, a2aCounterpartyIdentity: null,
  lastUserMessageContent: 'Can you check on the thing for me?', lastUserMessageId: null, triggerRow: contactRow, triggerWorkId: null,
  chosenConvKey: 'conv-pat', inboundChannel: 'imessage', inboundContext: null, latestUserSource: null,
  triggeredByIMessage: true, isA2ATurn: false, isEngineTurn: false, terminalWakeA2A: null, terminalWakeDrivesTurn: false,
  pendingEngineEvent: null, a2aReplyContext: null, contextWindow: 200000, isAutoRouted: false, configuredModelId: 'm-1',
  notificationTriggerRowid: null,
} as CounterpartyAndRecordInputs);

describe('replay of #28: a contact texts, the job needs the owner told, both are waiting', () => {
  it('every step names the contact, never the dashboard or the owner, and the owner is reached knowingly', async () => {
    // 1. Preflight: the turn's address is the TRIGGER's person (the contact, by iMessage).
    const turnCtx = openTurnContext(AGENT);
    const { counterparty } = await runCounterpartyAndRecord(turnCtx, { agentId: AGENT } as unknown as PreflightContext, {} as PreflightScratch, inputs());
    const address = turnCtx.address!;
    expect(address.kind).toBe('person');
    expect(address.name).toBe(CONTACT_ADDRESS);   // a contact with no saved name is named by their address
    expect(address.deliveryChannel).toBe('imessage');

    // 2. What the agent reads: ONE block, the contact by iMessage, with the owner reachable by an explicit send.
    const ctx = buildAssemblyContext(AGENT, 'm-1', { counterparty, address, isEngineTurn: false, isNotificationTurn: false, isA2ATurn: false, latestUserSource: null, othersWaiting: 1 } as never);
    const entry = getMessageEntries().find((e) => e.id === 'msg.turn-context')!;
    const block = (entry.render as (c: unknown) => { content: string })(ctx).content;
    expect(block).toContain(`Your written reply goes to **${CONTACT_ADDRESS}**`);
    expect(block).toContain('by iMessage');
    expect(block).toContain('Reply destination: iMessage to ' + CONTACT_ADDRESS);
    expect(block).toContain('explicit send that names Owner Example as the recipient');
    expect(block).not.toMatch(/dashboard chat|sole routing authority/);

    // 3. The agent tries to text the owner and forgets the recipient: the call does not run, and it is told who this turn is talking to.
    const refused = refuseSendWithNoRecipient(AGENT, 'imessage_send', { message: 'Pat asked about the thing' }, 'c1');
    expect(refused?.isError).toBe(true);
    expect(refused?.content).toContain(CONTACT_ADDRESS);
    expect(refused?.content).toContain('by iMessage');

    // 4. It names the owner: the send goes, and the result says plainly that the owner is NOT the person this turn is talking to.
    const note = recipientNoteFor(AGENT, 'imessage_send', { recipient: OWNER_ADDRESS, message: 'Pat asked about the thing' });
    expect(note).toContain(`This is not the person this turn is talking to (${CONTACT_ADDRESS}); your written reply still goes to ${CONTACT_ADDRESS}.`);

    // 5. The agent's written answer: delivery follows the address (the contact, iMessage), whatever else is newer or the owner's presence.
    for (const presence of ['in_dojo', 'away'] as const) {
      expect(resolveDeliveryChannel(address)).toBe('imessage');
    }
    expect(address.senderId).toBe(CONTACT_ADDRESS);

    // 6. On the next model call of the same turn, after the tool results, the newest message still names the contact.
    const clock = (entryId: string) => (getMessageEntries().find((e) => e.id === entryId)!.render as (c: unknown) => { content: string })(ctx).content;
    const lane = (text: string) => tagMessageLane({ role: 'user' as const, content: text }, 'msg.current-time');
    const H1 = [{ role: 'user' as const, content: 'ask' }, { role: 'assistant' as const, content: 'tool call' }];
    const H2 = [...H1, { role: 'user' as const, content: 'tool result' }];
    const turn = {};
    const c1 = clock('msg.current-time');
    await appendOnlyTurn({ turn, loopCount: 1, fresh: [...H1, lane(c1)], volatileFrom: H1.length, blocksFrom: H1.length, modelId: 'm', fits: async () => true });
    const r2 = await appendOnlyTurn({ turn, loopCount: 2, fresh: [...H2, lane(`${c1}\nlater`)], volatileFrom: H1.length, blocksFrom: H2.length, modelId: 'm', fits: async () => true });
    expect(String(r2.messages[r2.messages.length - 1].content)).toContain(`[Reply goes to ${CONTACT_ADDRESS} by iMessage.]`);
    endTurnContext(AGENT);
  });
});
