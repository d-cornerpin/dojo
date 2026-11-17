// A memory brought back on upgrade day gets a fair chance, then fades by the normal rules when nobody
// uses it: a month at 0.5, then one step a month, hidden again within about six months.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { freshVault, seedUpgradeDayVault, entry, nightsPass } from './helpers/fading-world.js';
import { MAIN } from '../../work/done/__tests__/helpers/decision-world.js';
import { markObsolete } from '../store.js';
import { runEngineMaintenance } from '../maintenance.js';

afterEach(() => vi.useRealTimers());

describe('a restored memory nobody uses fades again', () => {
  it('holds for a month, decays a step a month, and is hidden again, never restored twice', () => {
    freshVault('2026-11-20T09:00:00Z');
    seedUpgradeDayVault(MAIN, (id) => markObsolete(id, 'out of date'));
    runEngineMaintenance();
    nightsPass(29);
    expect(entry('hid-decayed')).toMatchObject({ is_obsolete: 0, confidence: 0.5 });
    nightsPass(2);
    expect(entry('hid-decayed').confidence).toBeCloseTo(0.4);
    nightsPass(150);
    expect(entry('hid-decayed').is_obsolete).toBe(1);
    nightsPass(30);
    expect(entry('hid-decayed').is_obsolete).toBe(1);
    expect(entry('hid-decayed').created_at).toBe('2026-03-01 10:00:00');
  });
});
