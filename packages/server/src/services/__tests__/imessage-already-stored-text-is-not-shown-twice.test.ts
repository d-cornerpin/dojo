// An iCloud re-insert of an old text under a fresh ROWID passes the poll filters and hits
// the unique index on (agent_id, channel, external_message_id): the row is NOT stored again.
// The dashboard must not get a second bubble for a message that was never stored, and no
// turn may be woken for it — but the cursor still has to move past the row. imsg/osascript
// are mocks; the inbound path is called directly, chat.db is never opened.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  handleMessage: vi.fn(async () => {}),
}));

vi.mock('../imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../imessage-run.js')>()),
  getImsgPath: () => null,
  runMessagesProgram: vi.fn(async () => ''),
}));
vi.mock('../../gateway/ws.js', async (orig) => ({
  ...(await orig<typeof import('../../gateway/ws.js')>()),
  broadcast: mocks.broadcast,
}));
vi.mock('../../agent/runtime.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/runtime.js')>()),
  getAgentRuntime: () => ({ handleMessage: mocks.handleMessage }),
}));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { processInboundIMessage } from '../imessage-bridge.js';

const SENDER = '+15550100198';
const storedRows = (guid: string): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE external_message_id = ?').get(guid) as { n: number }).n;
const cursor = (): string | undefined =>
  (getDb().prepare("SELECT value FROM config WHERE key = 'imessage_last_rowid'").get() as { value: string } | undefined)?.value;
const receive = (advanceRowId: number | null) =>
  processInboundIMessage({ sender: SENDER, cleanedText: 'hello', advanceRowId, wakeAgent: true, externalMessageId: 'GUID-1' });

beforeAll(() => {
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: SENDER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
});

describe('an inbound iMessage whose guid is already stored', () => {
  it('the first text is stored, shown, and wakes the agent once', async () => {
    const res = await receive(null);
    expect(res.outcome).toBe('dispatched');
    expect(storedRows('GUID-1')).toBe(1);
    expect(mocks.broadcast).toHaveBeenCalledTimes(1);
    expect(mocks.handleMessage).toHaveBeenCalledTimes(1);
  });
  it('the same guid again: one row, no second bubble, no second wake, dispatched outcome', async () => {
    mocks.broadcast.mockClear();
    mocks.handleMessage.mockClear();
    const res = await receive(205);
    expect(res.outcome).toBe('dispatched');
    expect(res.reply).toBeNull();
    expect(storedRows('GUID-1')).toBe(1);
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(mocks.handleMessage).not.toHaveBeenCalled();
  });
  it('the cursor still moves past the already-stored row', () => {
    expect(cursor()).toBe('205');
  });
});
