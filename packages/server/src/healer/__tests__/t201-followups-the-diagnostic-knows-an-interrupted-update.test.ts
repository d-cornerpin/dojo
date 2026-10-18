// ════════════════════════════════════════════════════════════════════════════════════════
// t201 follow-up 5 — THE HEALER'S DIAGNOSTIC KNOWS THE UPDATE PHASE `interrupted` (from t197).
//
// An update the installer did not live to finish ends in the phase `interrupted`: nothing was
// switched, the old build is live and whole. The watchdog tells the owner once and puts the
// marker back to `idle`; on a box with no phone number to text it stays `interrupted`. The
// diagnostic read only `rolled-back` and `failed-permanently`, so the phase produced nothing and
// the one durable, dashboard-visible trace of a cut-off update was missing. It now reports the
// phase as what it is: harmless, informational, nothing to fix, and it must not tempt the
// healer into forcing another update or rolling anything back.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t201-interrupted-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

const marker = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('../../update-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../update-state.js')>()),
  readMarker: () => marker.current,
}));

import { runMigrations } from '../../db/migrations.js';
import { compileDiagnosticReport } from '../diagnostic.js';
import { emptyMarker } from '../../update-state.js';

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; marker.current = null; });

const updateItems = () => compileDiagnosticReport().items.filter((i) => /^UPDATE_/.test(i.code));

describe('an interrupted update shows up in the diagnostic', () => {
  it('reports it once, as information, saying nothing changed and nothing needs fixing', () => {
    marker.current = { ...emptyMarker(), phase: 'interrupted', targetVersion: '3.4.0', previousVersion: '3.3.3' };
    const items = updateItems();
    expect(items.map((i) => i.code)).toEqual(['UPDATE_INTERRUPTED']);
    const item = items[0]!;
    expect(item.severity, 'nothing is broken: this is not a warning').toBe('info');
    expect(item.detail).toContain('3.3.3');
    expect(item.detail).toMatch(/nothing (was|had been) changed/i);
    expect(item.detail, 'the healer must not turn this into a second update or a rollback').toMatch(/do not (force|re-apply|try)/i);
  });

  it('CONTROLS: the two phases it already knew still report, and quiet phases stay quiet', () => {
    marker.current = { ...emptyMarker(), phase: 'rolled-back', previousVersion: '3.3.3' };
    expect(updateItems().map((i) => i.code)).toEqual(['UPDATE_ROLLED_BACK']);
    marker.current = { ...emptyMarker(), phase: 'failed-permanently' };
    expect(updateItems().map((i) => i.code)).toEqual(['UPDATE_FAILED_PERMANENTLY']);
    for (const phase of ['idle', 'healthy', 'pending-update', 'booting-new']) {
      marker.current = { ...emptyMarker(), phase };
      expect(updateItems().map((i) => i.code), phase).toEqual([]);
    }
  });
});
