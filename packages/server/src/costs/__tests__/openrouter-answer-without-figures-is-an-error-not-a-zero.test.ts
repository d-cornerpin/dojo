// ════════════════════════════════════════════════════════════════════════════════════════
// (#8802) — AN OPENROUTER ANSWER WITH NO CREDIT FIGURES IS AN ERROR, NOT A ZERO BALANCE.
//
// `readOpenRouterCredits` normalises the credits answer and defaults every missing field to 0.
// When a 200 carries none of them (an empty body, a wrapper with another name, an error sent
// with status 200), every number comes out 0 and the reader used to return `ok: true` with
// `balance: 0` — which the background check reads as "at or below the threshold", latches, and
// tells the owner his balance is $0.00 when nothing is known about it. The DeepSeek reader
// beside it already refuses its no-info case (`provider-balance-check.ts:101`); this pins that
// OpenRouter does the same, and that answers WITH figures still normalise exactly as before.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-openrouter-no-figures', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { readOpenRouterCredits } from '../provider-balance-check.js';

/** Answer the credits API with this body on a 200. Fake data only — no wire is touched. */
function answerWith(body: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('an OpenRouter 200 with no credit figures', () => {
  it('is refused as an error, not read as a zero balance', async () => {
    answerWith({ data: {} });
    const r = await readOpenRouterCredits('fake');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('OpenRouter returned no credit figures');
  });

  it('figures that are there still normalise: { data: { total_credits: 10, total_usage: 4 } } is $6', async () => {
    answerWith({ data: { total_credits: 10, total_usage: 4 } });
    const r = await readOpenRouterCredits('fake');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.balance).toBe(6);
  });

  it('a flat balance is read as-is: { balance: 2.5 } is $2.50', async () => {
    answerWith({ balance: 2.5 });
    const r = await readOpenRouterCredits('fake');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.balance).toBe(2.5);
  });
});
