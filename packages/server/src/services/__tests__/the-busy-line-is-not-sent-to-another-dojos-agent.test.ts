// A busy-ack to another Dojo's agent lands on that box and starts a paid turn there: the line
// goes to people only. The sender's own text still wakes this agent either way.
// imsg/osascript are mocks; the inbound path is called directly, chat.db is never opened.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  handleMessage: vi.fn(async () => {}),
}));
const runMock = vi.hoisted(() => vi.fn(async (_program: string, _argv: readonly string[]) => ''));

vi.mock('../imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../imessage-run.js')>()),
  getImsgPath: () => null,
  runMessagesProgram: runMock,
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
import { activeRuns, agentStartTimes } from '../../agent/shared-state.js';
import { processInboundIMessage } from '../imessage-bridge.js';

const busyTexts = () => runMock.mock.calls.filter((c) => JSON.stringify(c).includes('Dojo: your message arrived')).length;

beforeAll(() => {
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: '+15550100198', name: 'Owner', is_primary: true, sharing_level: 'open_book' }, { address: '+15550100400', name: 'Partner Agent', is_agent: true, sharing_level: 'dont_overshare' }, { address: '+15550100500', name: 'Friend', sharing_level: 'dont_overshare' }]));
});

beforeEach(() => {
  runMock.mockClear();
  activeRuns.add('primary');
  agentStartTimes.set('primary', Date.now() - 120_000);
});
afterEach(() => {
  activeRuns.delete('primary');
  agentStartTimes.delete('primary');
});

describe('the busy line', () => {
  it("is not sent to another Dojo's agent", async () => {
    await processInboundIMessage({ sender: '+15550100400', cleanedText: 'Here are the three dates for the dinner: May 4, May 11 and May 18', advanceRowId: null, wakeAgent: true, externalMessageId: 'GUID-agent-1' });
    await vi.waitFor(() => expect(mocks.handleMessage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(busyTexts()).toBe(0);
  });
  it('still goes to a person', async () => {
    await processInboundIMessage({ sender: '+15550100500', cleanedText: 'Are we still on for dinner on May 4?', advanceRowId: null, wakeAgent: true, externalMessageId: 'GUID-person-1' });
    await vi.waitFor(() => expect(busyTexts()).toBe(1));
  });
});
