// A card the owner dismissed before the upgrade stays dismissed when its site next speaks the same sentence: the row
// from before has no words, which reads as the same words, and the words are filled in without a push.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
const frames = vi.hoisted(() => [] as unknown[]);
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: unknown) => { frames.push(f); }, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { boxBefore901, upgrade, HELPER } from './helpers/a-box-before-901.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { tellOwner, stuckWords, ownerToldOf } from '../../healer/owner-notices.js';

describe('a card dismissed before the upgrade stays dismissed', () => {
  it('its site speaking again pushes nothing, keeps the dismissal, and records the words', () => {
    boxBefore901();
    const key = `stuck:${HELPER}`;
    doneDb().prepare("INSERT INTO healer_state (scope, key, at_ms) VALUES ('owner_told', ?, 1), ('owner_dismissed', ?, 2)").run(key, key);
    upgrade();
    frames.length = 0;
    expect(tellOwner(key, stuckWords(HELPER))).toBe(false);
    expect(frames).toEqual([]);
    expect(ownerToldOf(key)).toBe(false);
    expect(doneDb().prepare("SELECT value FROM healer_state WHERE scope = 'owner_told' AND key = ?").get(key)).toEqual({ value: stuckWords(HELPER) });
  });
});
