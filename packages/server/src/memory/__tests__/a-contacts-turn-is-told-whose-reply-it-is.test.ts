// A contact's turn sees the owner's recent rows (labelled, never hidden), so what the model is handed
// must say both things: the owner's row is his, in his conversation, and this reply goes to the contact.
// Driven the way a turn builds its call: `assembleContext`, then the turn-context injection.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../db/migrations.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { insertMessage } from '../message-store.js';
import { assembleContext } from '../assembler.js';
import { buildAssemblyContext, injectRegistryMessage } from '../../prompt/registry/assembler.js';
import '../../prompt/registry/entries.js';
import { computeTurnAddress } from '../../agent/v2/turn-address.js';
import type { TurnCounterparty } from '../../agent/v2/counterparty.js';

const AGENT = 'primary';
const CONTACT = '+15550100';
let image: Buffer | null = null;
function freshDb(): Database.Database {
  if (!image) {
    const s = new Database(':memory:');
    mockDb.current = s;
    runMigrations();
    image = s.serialize();
    s.close();
  }
  return new Database(image);
}

beforeEach(() => {
  const db = freshDb();
  mockDb.current = db;
  db.prepare("INSERT INTO config (key, value) VALUES ('owner_name', 'Owner Example')").run();
  clearPlatformConfigCache();
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')").run();
  db.prepare("INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-dash', 'primary', 'dashboard', 'owner')").run();
  db.prepare("INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-contact', 'primary', 'imessage', ?)").run(CONTACT);
  insertMessage({
    id: 'owner-ask', agentId: AGENT, role: 'user', content: 'Please move my dentist appointment to Friday.', turnNumber: 1,
    channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  });
  insertMessage({ id: 'owner-reply', agentId: AGENT, role: 'assistant', content: 'On it.', turnNumber: 1, channel: 'dashboard', conversationId: 'conv-dash' });
  insertMessage({
    id: 'contact-ask', agentId: AGENT, role: 'user', content: 'Is the garden party still on Saturday?', turnNumber: 2,
    channel: 'imessage', senderId: CONTACT, authorized: true, conversationId: 'conv-contact',
    inboundMeta: JSON.stringify({ channel: 'imessage', relation: 'known_contact', sender: CONTACT, authorized: true }),
  } as never);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; clearPlatformConfigCache(); });

describe("a contact's turn is told whose reply it is", () => {
  it('the header names the contact as the recipient, and the owner row in view is labelled as his', async () => {
    const counterparty: TurnCounterparty = { kind: 'user', name: 'Pat Example', relation: 'known_contact', channel: 'imessage', senderId: CONTACT, threadId: null, senderIsAgent: false };
    const address = computeTurnAddress({ autoRoutes: true, counterparty, isEngineTurn: false, isNotificationTurn: false,
      inboundChannel: 'imessage', inboundContext: null });
    const turn = { latestUserSource: 'text' as const, counterparty, address, isEngineTurn: false, isNotificationTurn: false };
    const ctx = await assembleContext(AGENT, 'm', turn);
    injectRegistryMessage('msg.turn-context', ctx.messages, buildAssemblyContext(AGENT, 'm', turn));
    const texts = ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

    const header = texts.find((t) => t.includes('[Turn context]'));
    expect(header, 'the turn context header is assembled').toBeTruthy();
    expect(header).toContain('Your written reply goes to **Pat Example**');

    const ownerRow = texts.find((t) => t.includes('move my dentist appointment'));
    expect(ownerRow, "the owner's row stays in view").toBeTruthy();
    expect(ownerRow).toMatch(/· dashboard conversation with Owner Example\] Please move my dentist appointment/);
  });
});
