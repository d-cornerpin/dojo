// A memory that comes up every week keeps its place: half a year of nightly clean-up leaves it visible
// and at full confidence, because each search that returns it is recorded as a use.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { freshVault, seedEntry, entry, nightsPass } from './helpers/fading-world.js';
import { call, MAIN } from '../../work/done/__tests__/helpers/decision-world.js';

afterEach(() => vi.useRealTimers());

describe('a memory recalled weekly is not hidden at 180 days', () => {
  it('stays visible and unfaded after 200 days of weekly searches', async () => {
    freshVault('2026-11-20T09:00:00Z');
    seedEntry('weekly-1', MAIN, { content: 'The boiler service is booked with the northside plumber' });
    for (let week = 0; week < 29; week++) {
      const found = await call(MAIN, 'vault_search', { query: 'northside plumber', mode: 'exact' });
      expect(found.content).toContain('weekly-1');
      nightsPass(7);
    }
    expect(entry('weekly-1').is_obsolete).toBe(0);
    expect(entry('weekly-1').confidence).toBe(1);
    expect(entry('weekly-1').retrieval_count).toBe(29);
  });
});
