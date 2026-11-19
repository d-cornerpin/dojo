import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPrimaryAgentId: () => 'primary', getDreamerAgentId: () => 'dreamer', isSetupCompleted: () => true,
}));
const handleMessage = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage }) }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/spawner.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../agent/v2/counterparty.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), rehomeUnclaimedEngineEvents: vi.fn() }));
vi.mock('../../agent/session-forget.js', () => ({ forgetSessionScratch: vi.fn(async () => undefined) }));
vi.mock('../../memory/shape-judgment.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), settleFiller: vi.fn(async () => undefined) }));

import { runMigrations } from '../../db/migrations.js';
import { archiveConversation } from '../store.js';
import { isDreamCycleOpen, setDreamCycleOpen, runDreamerContinuationSweep } from '../maintenance.js';

const TALK = [
  { role: 'user', content: 'We need to redesign the onboarding flow so a new user can connect their calendar and mailbox in the first session without hitting the permission wall. Outline the concrete steps and the order to ship them in.' },
  { role: 'assistant', content: 'Here is the plan. First, split the consent screen into per-service cards so calendar and mail are granted independently. Second, defer the mailbox scope until the user opens the inbox panel. Third, add a skip option that still lets them finish setup.' },
];
let archiveId = '';
const sweepHalfAnHourLater = async (): Promise<void> => {
  vi.setSystemTime(Date.now() + 31 * 60_000);
  await runDreamerContinuationSweep();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-11-18T03:00:00Z'));
  handleMessage.mockClear();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const db = mockDb.current;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'openai-compatible', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
              VALUES ('m', 'p', 'M', 'm', '["text"]', 32000, 4096, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('primary', 'Main', 'm', 'idle', '{}')").run();
  archiveId = archiveConversation({ agentId: 'primary', messages: TALK, messageCount: 2, tokenCount: 200, earliestAt: '2026-11-17 09:00:00', latestAt: '2026-11-17 09:05:00' });
  db.prepare("INSERT INTO agents (id, name, model_id, status, parent_agent, config) VALUES ('dreamer', 'Dreamer', 'm', 'idle', 'primary', ?)")
    .run(JSON.stringify({ dreamerArchiveIds: [archiveId] }));
  setDreamCycleOpen(true);   // the nightly send already went out and the Dreamer stopped without complete_task
});
afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

describe('a stalled dream batch is sent at most three times', () => {
  it('after the nightly send it is re-sent twice, then parked, and the cycle closes', async () => {
    await sweepHalfAnHourLater();
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(1));
    await sweepHalfAnHourLater();
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(2));
    await sweepHalfAnHourLater();
    await vi.waitFor(() => expect(isDreamCycleOpen()).toBe(false));
    await sweepHalfAnHourLater();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(mockDb.current!.prepare('SELECT attempts, poisoned FROM vault_conversations WHERE id = ?').get(archiveId))
      .toEqual({ attempts: 3, poisoned: 1 });
  });
});
