// A migrated scratch vault for the fading tests: rows written as the nightly clean-up leaves them, a
// fake calendar, and nights of the real engine maintenance. Each test file mocks, before importing this:
//
//   vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
//   vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
import { vi } from 'vitest';
import { runEngineMaintenance } from '../../maintenance.js';
import { freshBoard } from '../../../work/done/__tests__/helpers/decision-world.js';
import { doneDb } from '../../../work/done/__tests__/helpers/done-db.js';

export const DAY = 24 * 60 * 60 * 1000;
export const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** A fresh migrated board with the calendar frozen at `at` (only Date is faked; timers stay real). */
export function freshVault(at: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
  freshBoard();
}

export interface Row {
  id: string; agent_id: string; content: string; confidence: number; is_obsolete: number; is_pinned: number;
  is_permanent: number; superseded_by: string | null; retrieval_count: number; last_retrieved_at: string | null;
  last_decayed_at: string | null; created_at: string; updated_at: string;
}

/** One vault row, written directly with the columns a test names. */
export function seedEntry(id: string, agentId: string, cols: Partial<Omit<Row, 'id' | 'agent_id'>> = {}): void {
  const now = stamp(Date.now());
  const full = { content: `fixture memory ${id}`, confidence: 1, is_obsolete: 0, is_pinned: 0, is_permanent: 0,
    superseded_by: null, retrieval_count: 0, last_retrieved_at: null, last_decayed_at: null,
    created_at: now, updated_at: now, ...cols };
  const keys = Object.keys(full);
  doneDb().prepare(`INSERT INTO vault_entries (id, agent_id, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
    .run(id, agentId, ...Object.values(full));
}

export const entry = (id: string): Row => doneDb().prepare('SELECT * FROM vault_entries WHERE id = ?').get(id) as Row;

/** `days` nights pass, the engine maintenance running once each night. */
export function nightsPass(days: number): void {
  for (let i = 0; i < days; i++) {
    vi.setSystemTime(new Date(Date.now() + DAY));
    runEngineMaintenance();
  }
}

/** An agent's stored `vault_forget` call for `entryId`, as the turn loop persists a tool call. */
export function storedForgetCall(agentId: string, entryId: string): void {
  const at = Date.now();
  const content = JSON.stringify([{ type: 'tool_use', id: `tu-${entryId}`, name: 'vault_forget', input: { entry_id: entryId, reason: 'no longer true' } }]);
  doneDb().prepare(
    `INSERT INTO messages (id, agent_id, lane, role, content, authorized, sent_at, created_at) VALUES (?, ?, 'owner', 'assistant', ?, 1, ?, ?)`,
  ).run(`msg-forget-${entryId}`, agentId, content, at, at);
}

/** The five rows of a box the clean-up ran on since 2026-08-31: two it hid, three hidden on purpose. */
export function seedUpgradeDayVault(agentId: string, markOnMemoryPage: (id: string) => void): void {
  seedEntry('hid-decayed', agentId, { confidence: 0.05, is_obsolete: 1, created_at: '2026-03-01 10:00:00', updated_at: '2026-09-15 03:00:00', last_decayed_at: '2026-09-15 03:00:00' });
  seedEntry('hid-aged-out', agentId, { is_obsolete: 1, created_at: '2026-02-01 10:00:00', updated_at: '2026-10-01 03:00:00' });
  seedEntry('forgotten', agentId, { is_obsolete: 1, created_at: '2026-04-01 10:00:00', updated_at: '2026-10-05 12:00:00' });
  storedForgetCall(agentId, 'forgotten');
  seedEntry('corrected', agentId, { is_obsolete: 1, superseded_by: 'hid-aged-out', created_at: '2026-04-02 10:00:00', updated_at: '2026-10-06 12:00:00' });
  seedEntry('marked-obsolete', agentId, { created_at: '2026-04-03 10:00:00' });
  markOnMemoryPage('marked-obsolete');
}
