// The reply questions read the reply as the person sees it: the leading mood marker is not part of it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import '../decision-ask.js';
import { __forgetResidencyForTests } from '../decide.js';
import { askReplyClaims } from '../v2/reply-claims.js';
import { installDecisionModel, scriptDecisions, yes } from './decision-fake.js';
import { unfenceExternal } from '../../tools/external-content.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  installDecisionModel(mockDb.current);
  __forgetResidencyForTests();
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('the reply sent to the decision model', () => {
  it('carries no mood marker', async () => {
    const calls = scriptDecisions(() => yes(0.1));
    const prepare = (): { get: () => unknown } => ({ get: () => undefined });
    await askReplyClaims({ toolResults: [] } as never,
      { agentId: 'a1', messageId: 'm1', db: { prepare }, turnNumber: 1, result: { toolCalls: [] }, lastUserMessageContent: 'what is 7 times 8?' } as never,
      '((mood: calm)) 7 x 8 = 56. Ready when you are.');
    expect(unfenceExternal((calls[0].state as Record<string, string>).reply)).toBe('7 x 8 = 56. Ready when you are.');
  });
});
