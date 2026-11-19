// Fading is by design: a memory nobody uses loses a step of confidence each unused month and is hidden
// by the nightly clean-up in the end, never deleted.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { freshVault, seedEntry, entry, nightsPass } from './helpers/fading-world.js';
import { call, MAIN } from '../../work/done/__tests__/helpers/decision-world.js';

afterEach(() => vi.useRealTimers());

describe('an unused memory still fades', () => {
  it('decays month by month and is hidden, while a searched neighbour stays', async () => {
    freshVault('2026-11-20T09:00:00Z');
    seedEntry('unused-1', MAIN, { content: 'The old gate code was changed in spring' });
    seedEntry('used-1', MAIN, { content: 'The garden hose lives behind the shed' });
    nightsPass(65);
    expect(entry('unused-1').confidence).toBeCloseTo(0.8);
    for (let week = 0; week < 20; week++) {
      await call(MAIN, 'vault_search', { query: 'garden hose', mode: 'exact' });
      nightsPass(7);
    }
    expect(entry('unused-1').is_obsolete).toBe(1);
    expect(entry('unused-1').content).toBe('The old gate code was changed in spring');
    expect(entry('used-1').is_obsolete).toBe(0);
  });
});
