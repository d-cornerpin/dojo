// Upgrade day touches only the memories it brings back: every visible memory keeps its confidence, its
// use count, its last-used and last-faded times and its dates exactly as they were.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { freshVault, seedUpgradeDayVault, seedEntry, entry } from './helpers/fading-world.js';
import { MAIN } from '../../work/done/__tests__/helpers/decision-world.js';
import { markObsolete } from '../store.js';
import { runEngineMaintenance } from '../maintenance.js';

afterEach(() => vi.useRealTimers());

describe('upgrade day leaves every live memory clock alone', () => {
  it('changes no column of a visible memory', () => {
    freshVault('2026-11-20T09:00:00Z');
    seedUpgradeDayVault(MAIN, (id) => markObsolete(id, 'out of date'));
    seedEntry('live-used', MAIN, { confidence: 0.7, retrieval_count: 4, last_retrieved_at: '2026-11-01 08:00:00', last_decayed_at: '2026-10-25 03:00:00', created_at: '2026-10-20 10:00:00', updated_at: '2026-11-01 08:00:00' });
    seedEntry('live-new', MAIN, { confidence: 0.9, created_at: '2026-11-18 10:00:00', updated_at: '2026-11-18 10:00:00' });
    seedEntry('live-pinned', MAIN, { is_pinned: 1, created_at: '2026-11-02 10:00:00', updated_at: '2026-11-02 10:00:00' });
    const before = ['live-used', 'live-new', 'live-pinned'].map(entry);
    runEngineMaintenance();
    expect(['live-used', 'live-new', 'live-pinned'].map(entry)).toEqual(before);
  });
});
