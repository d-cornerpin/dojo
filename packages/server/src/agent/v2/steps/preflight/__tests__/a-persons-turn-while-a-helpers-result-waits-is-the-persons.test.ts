// A person's turn while a helper's result also waits belongs to the person's conversation: the turn is recorded as
// a user turn on that conversation, not on the helper's thread, and the result stays owed for its own turn.
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
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { openTurnContext, endTurnContext } from '../../../../turn-context.js';
import { runPreflight, type PreflightContext } from '../index.js';
import { nextOwed } from '../../../owed.js';

const AGENT = 'worker';
const ctx = {
  agentId: AGENT, setAgentStatus: () => undefined, startStatusHeartbeat: () => undefined,
  stopStatusHeartbeat: () => undefined, engineStartAckAfterMs: 60_000,
} as unknown as PreflightContext;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 40000, 1)`).run();
  mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES (?, 'Worker', 'm', 'idle', '{}', 'sensei')").run(AGENT);
  insertMessage({
    agentId: AGENT, role: 'user', lane: 'a2a', sourceAgentId: 'helper', a2aThreadId: 'thr-1',
    a2aIntent: 'DELIVERABLE', a2aRequiresResponse: true, content: '[A2A:DELIVERABLE thread:thr-1 from:Helper] the figures',
  });
  insertMessage({
    id: 'm-owner', agentId: AGENT, role: 'user', content: 'what is on today?', lane: 'owner', channel: 'dashboard',
    senderId: 'owner', authorized: true, inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as never);
});
afterEach(() => { endTurnContext(AGENT); mockDb.current?.close(); mockDb.current = null; });

describe('a person\'s turn while a helper\'s result waits is the person\'s', () => {
  it('the turn is a user turn on the person\'s conversation, and the result stays owed', async () => {
    const out = await runPreflight(openTurnContext(AGENT), ctx);
    if (out.directive !== 'proceed') throw new Error('expected proceed');
    const turn = mockDb.current!.prepare('SELECT kind, subject_kind FROM turns WHERE agent_id = ? AND turn_number = ?')
      .get(AGENT, out.outputs.turnNumber) as { kind: string; subject_kind: string };
    expect(turn).toEqual({ kind: 'user', subject_kind: 'conv' });
    expect(nextOwed(AGENT).map((i) => i.kind)).toEqual(['agentResult']);
  });
});
