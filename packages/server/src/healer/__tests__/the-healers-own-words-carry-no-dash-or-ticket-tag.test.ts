// The Healer's own words are plain: the history lines and the daily report text the owner reads
// carry no typographic em-dash and no ticket code.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({}) }));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { compileDiagnosticReport } from '../diagnostic.js';
import { runAutoFixes } from '../auto-fix.js';

const EM_DASH = String.fromCharCode(0x2014);
beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe("the Healer's own words carry no dash or ticket tag", () => {
  it('an unfreeze is written in plain words', () => {
    mockDb.current!.prepare(
      "INSERT INTO agents (id, name, status, config, updated_at) VALUES ('a1', 'helper one', 'working', '{}', datetime('now', '-3 hours'))",
    ).run();
    runAutoFixes('d1', [{ severity: 'critical', code: 'STUCK_AGENT', title: 't', detail: 'd', agentId: 'a1', agentName: 'helper one' }]);
    const rows = mockDb.current!.prepare(
      "SELECT description FROM healer_actions WHERE diagnostic_id = 'd1'",
    ).all() as Array<{ description: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('Unfroze helper one: it was stuck and not responding');
  });

  it('the report text has no em-dash', () => {
    const report = compileDiagnosticReport() as unknown as { reportText: string };
    expect(report.reportText).not.toContain(EM_DASH);
    expect(report.reportText.startsWith('═══ DOJO DAILY DIAGNOSTIC, ')).toBe(true);
  });
});
