// ════════════════════════════════════════════════════════════════════════════════════
// T277 — the Healer's schedule never computes a NaN delay.
//
// The scheduler turns the stored "HH:MM" text into the next run time with no validation.
// For a bad time text ('' , '9am', '4', '24:00', '12:60', a number, undefined) the split
// gives NaN or undefined for hours or minutes, setHours makes an Invalid Date, and the
// resulting delay is NaN — setTimeout(fn, NaN) fires after a few ms, so healing cycles
// run back-to-back with no daily pause. The exported helper below is the only place the
// text is turned into a delay; it rejects anything that is not a valid HH:MM and falls
// back to the configured default instead.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.setConfig({ testTimeout: 30_000 });

const { mockDb } = vi.hoisted(() => ({ mockDb: { current: null as Database.Database | null } }));
vi.mock('../../db/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/connection.js')>('../../db/connection.js');
  return { ...actual, getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; } };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { nextDailyRunDelayMs } from '../healer-agent.js';

describe('nextDailyRunDelayMs', () => {
  const now = new Date(2026, 0, 15, 10, 30, 0, 0); // local time, so cases do not depend on the machine's zone

  it('schedules a valid time later today', () => {
    const { delayMs, usedFallback } = nextDailyRunDelayMs('12:00', '04:00', now);
    expect(usedFallback).toBe(false);
    expect(delayMs).toBe(1.5 * 3600_000); // 5_400_000
  });

  it('schedules a valid time that is already past for tomorrow', () => {
    const { delayMs, usedFallback } = nextDailyRunDelayMs('04:00', '04:00', now);
    expect(usedFallback).toBe(false);
    expect(delayMs).toBe(17.5 * 3600_000); // 63_000_000
  });

  it('an exact match of now is not later, so it moves a day on', () => {
    const { delayMs, usedFallback } = nextDailyRunDelayMs('10:30', '04:00', now);
    expect(usedFallback).toBe(false);
    expect(delayMs).toBe(86_400_000);
  });

  it('accepts a single-digit hour with zero-padded minutes', () => {
    const { delayMs, usedFallback } = nextDailyRunDelayMs('4:05', '04:00', now);
    expect(usedFallback).toBe(false);
    expect(delayMs).toBe(17 * 3600_000 + 35 * 60_000); // 63_300_000
  });

  it.each(['', '9am', '4', '24:00', '12:60', 'ab:cd', undefined, 4])('rejects %j and falls back to the default', (bad) => {
    const { delayMs, usedFallback } = nextDailyRunDelayMs(bad as string, '04:00', now);
    expect(usedFallback).toBe(true);
    expect(delayMs).toBe(17.5 * 3600_000); // 63_000_000
  });

  it('every result is a finite, positive delay', () => {
    for (const text of ['04:00', '12:00', '10:30', '4:05', '', '9am', '4', '24:00', '12:60', 'ab:cd', undefined, 4]) {
      const { delayMs } = nextDailyRunDelayMs(text as string, '04:00', now);
      expect(Number.isFinite(delayMs)).toBe(true);
      expect(delayMs).toBeGreaterThan(0);
    }
  });
});
