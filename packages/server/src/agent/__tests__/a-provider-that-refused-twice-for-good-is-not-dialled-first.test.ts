// Every failed model call reports to the billing breaker through the shared catch, `settleFailedCall`.
// Only PERMANENT refusals (402 / 401 / 403) open it: after two of them the provider is OPEN and the
// router stops dialling it first. A passing server error is not permanent, and a call its caller
// stopped is no failure at all, so neither notes anything.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const o = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-breaker-hears-a-failed-call', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
const providerErrors = vi.hoisted(() => ({ ids: [] as string[], successes: [] as string[] }));
vi.mock('../../gateway/routes/services.js', () => ({
  recordProviderError: (id: string) => { providerErrors.ids.push(id); },
  recordProviderSuccess: (id: string) => { providerErrors.successes.push(id); },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { runMigrations } from '../../db/migrations.js';
import { settleFailedCall } from '../failed-call.js';
import { mayDialProvider, providerBreaker, __resetBreakersForTests } from '../../providers/billing-breaker.js';

beforeEach(() => {
  __resetBreakersForTests();
  providerErrors.ids = [];
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const fail = (message: string) => settleFailedCall('Model call', message, {}, { providerId: 'p-paid', agentId: 'a-1' });

describe('the breaker hears a failed model call', () => {
  it('two out-of-balance refusals open the breaker', () => {
    fail('402 Payment Required: insufficient balance');
    fail('402 Payment Required: insufficient balance');
    const open = providerBreaker('p-paid');
    expect(open).not.toBeNull();
    expect(open?.reason).toBe('no_balance');
    expect(mayDialProvider('p-paid'), 'the router will not dial it first').toBe(false);
  });

  it('one refusal does not open it', () => {
    fail('402 Payment Required: insufficient balance');
    expect(providerBreaker('p-paid')).toBeNull();
    expect(mayDialProvider('p-paid')).toBe(true);
  });

  it('passing server errors never open it', () => {
    fail('500 Internal Server Error');
    fail('500 Internal Server Error');
    fail('500 Internal Server Error');
    expect(providerBreaker('p-paid'), 'transient is the recovery cascade\'s, not the breaker\'s').toBeNull();
    expect(providerErrors.ids).toEqual(['p-paid', 'p-paid', 'p-paid']);
  });

  it('a call its caller stopped notes nothing', () => {
    const ac = new AbortController();
    ac.abort();
    settleFailedCall('Model call', '402 Payment Required: insufficient balance', {}, { providerId: 'p-paid', agentId: 'a-1', signal: ac.signal });
    settleFailedCall('Model call', '402 Payment Required: insufficient balance', {}, { providerId: 'p-paid', agentId: 'a-1', signal: ac.signal });
    expect(providerBreaker('p-paid')).toBeNull();
    expect(providerErrors.ids).toEqual([]);
  });
});
