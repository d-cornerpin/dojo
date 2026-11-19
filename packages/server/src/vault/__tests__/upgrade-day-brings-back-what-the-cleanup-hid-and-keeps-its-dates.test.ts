// Upgrade day: the first maintenance pass brings back, once, the memories the nightly clean-up hid since
// use stopped being recorded, with their true dates and one use counted on the day they return. A memory
// an agent forgot, a correction replaced, a person marked Obsolete, or a closed commitment stays hidden.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { freshVault, seedUpgradeDayVault, seedEntry, entry, stamp } from './helpers/fading-world.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { MAIN } from '../../work/done/__tests__/helpers/decision-world.js';
import { markObsolete } from '../store.js';
import { runEngineMaintenance } from '../maintenance.js';

afterEach(() => vi.useRealTimers());

describe('upgrade day brings back what the clean-up hid and keeps its dates', () => {
  it('restores only the two clean-up hides, each with one use at the restore', () => {
    freshVault('2026-11-20T09:00:00Z');
    seedUpgradeDayVault(MAIN, (id) => markObsolete(id, 'out of date'));
    runEngineMaintenance();
    for (const [id, created] of [['hid-decayed', '2026-03-01 10:00:00'], ['hid-aged-out', '2026-02-01 10:00:00']] as const) {
      expect(entry(id)).toMatchObject({ is_obsolete: 0, created_at: created, retrieval_count: 1, last_retrieved_at: stamp(Date.now()) });
      expect(entry(id).confidence).toBeGreaterThanOrEqual(0.5);
    }
    expect(entry('hid-aged-out').confidence).toBe(1);
    for (const id of ['forgotten', 'corrected', 'marked-obsolete']) expect(entry(id).is_obsolete, id).toBe(1);
  });

  it('keeps hidden the memory of a commitment that was given up, after its log line has rotated away', () => {
    freshVault('2026-11-20T09:00:00Z');
    doneDb().prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at, closed_at)
       VALUES ('cmt:0a1b2c3d4e5f', 'commitment', ?, 'agent', 'commitment', 'turn:1', 'abandoned', 'commitment', 0, 0, 'Send the quote', ?, ?, ?)`,
    ).run(MAIN, Date.now(), Date.now(), Date.now());
    seedEntry('kept-promise', MAIN, { content: 'Commitment: send the quote (cmt:0a1b2c3d4e5f)', is_obsolete: 1, updated_at: '2026-10-07 12:00:00' });
    runEngineMaintenance();
    expect(entry('kept-promise').is_obsolete).toBe(1);
  });
});
