// The full integrity read of the live database runs once a day by the clock, whatever restarts the
// watchdog, and once more after an update's first healthy start.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyState, integrityDue, persistState, readState, INTEGRITY_EVERY_MS } from '../../../../../watchdog/src/alert-ledger.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');

describe('the integrity check runs daily and after an update', () => {
  it('runs when never run or a day has passed, not before', () => {
    expect(integrityDue(null, null, NOW)).toBe(true);
    expect(integrityDue(NOW - 3_600_000, null, NOW)).toBe(false);
    expect(integrityDue(NOW - INTEGRITY_EVERY_MS, null, NOW)).toBe(true);
  });

  it('runs once after an update first came up healthy', () => {
    const healthyAt = new Date(NOW - 60_000).toISOString();
    expect(integrityDue(NOW - 3_600_000, healthyAt, NOW)).toBe(true);
    expect(integrityDue(NOW - 30_000, healthyAt, NOW), 'already run since').toBe(false);
  });

  it('the time of the last check survives a watchdog restart', () => {
    const file = path.join(fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'wd-state-')), 'watchdog-state.json');
    persistState({ ...emptyState(), lastIntegrityAt: NOW }, file);
    expect(readState(file).lastIntegrityAt).toBe(NOW);
  });
});
