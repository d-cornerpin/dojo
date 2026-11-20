// Every periodic obligation sweep is registered in the one reaper, with its cadence and where it came from.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({ getDb: () => { throw new Error('no database in this test'); }, closeDb: vi.fn() }));

import { REAPER_KINDS, REAPER_BASE_TICK_MS } from '../work-reaper.js';

describe('T9 — every obligation sweep routes through the one reaper', () => {
  it('each registered kind declares its cadence AND where that cadence came from', () => {
    expect(REAPER_KINDS.length).toBeGreaterThan(0);
    for (const k of REAPER_KINDS) {
      expect(k.everyMs, `${k.id}: cadence must be positive`).toBeGreaterThan(0);
      // NO INVENTED CADENCE (#14). Every period is a multiple of the base tick and names the
      // clock it was taken from.
      expect(k.everyMs % REAPER_BASE_TICK_MS, `${k.id}: ${k.everyMs} is not a multiple of the base tick`).toBe(0);
      expect(k.cadenceFrom.length, `${k.id}: no cadence provenance`).toBeGreaterThan(20);
      expect(typeof k.run).toBe('function');
    }
  });

  it('kind ids are unique — one owner per job', () => {
    const ids = REAPER_KINDS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('PLANTED FAULT: a second timer for an owned sweep would be caught', () => {
    // The scanner's own shape, proven against the text the offence would look like.
    const planted = "setInterval(() => { void sweepExpiredJoins(); }, 600000)";
    const hit = [...planted.matchAll(/setInterval\(([\s\S]{0,700}?)\},\s*[^)]*\)/g)]
      .some((m) => m[1].includes('sweepExpiredJoins'));
    expect(hit).toBe(true);
    const innocent = "// the reaper owns sweepExpiredJoins now";
    expect([...innocent.matchAll(/setInterval\(([\s\S]{0,700}?)\},\s*[^)]*\)/g)].length).toBe(0);
  });
});
