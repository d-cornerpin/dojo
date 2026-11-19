// v3.5 field fix 3, test-2 rank 6: THE INTEGRATION-STATUS FAILURE CARRIES ITS ACCOUNT AND EXPIRES ON A
// REAL SIGNAL.
//
// The owner's second field test: the block printed "UNRESOLVED FAILURE: gmail_list_labels ... with no
// success of that tool since" for ONE failure of the AGENT's own-account tool, from whenever, and the
// model concluded label listing was broken, on the owner's mailbox too. Only a success of that exact
// tool cleared it, and an agent that believes the block never calls the tool: a self-sealing loop.
//
// Now, per family and per ACCOUNT (the agent's own tools, or the owner's `user_` twins), only the
// NEWEST outcome counts: a later success of any tool on that account clears the failure, a later
// different failure replaces it, and a failure from before the agent's current session boundary is
// history, not status. The line says which account and when (an absolute recorded instant; no
// relative time, which would move the block every turn). The per-tool ledger itself is unchanged.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));
vi.mock('../../services/capability-registry.js', () => ({ listIntegrationStatuses: () => [
  { name: 'google' as const, configured: true, connected: true },
] }));
vi.mock('../../agent/access/read.js', () => ({ mayUsePlaud: () => false, widestIntegrationLevel: () => 'full' }));
vi.mock('../../plaud/auth.js', () => ({ getPlaudStatus: () => ({ connected: false, connectedAt: null }) }));

import { runMigrations } from '../../db/migrations.js';
import { buildIntegrationStatusLane } from '../integration-status-lane.js';

const AGENT = 'agent-rank6';
const stamp = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
const NOW = Date.now();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function outcome(tool: string, o: { okAt?: number; failAt?: number; streak?: number }): void {
  mockDb.current!.prepare(
    `INSERT INTO agent_tool_outcomes (agent_id, tool_name, last_ok_at, last_fail_at, last_error, consecutive_failures, total_failures)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(AGENT, tool, o.okAt ? stamp(o.okAt) : null, o.failAt ? stamp(o.failAt) : null,
    o.failAt ? 'seeded failure' : null, o.streak ?? 0, o.streak ?? 0);
}
const googleLine = async (): Promise<string> =>
  ((await buildIntegrationStatusLane(AGENT)) ?? '').split('\n').find((l) => l.startsWith('• Google Workspace')) ?? '';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'R6', 'idle', NULL, '{}')").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('rank 6: the failure names its account and its instant', () => {
  it('a recent failure of the agent\'s own-account tool prints, tagged with that account', async () => {
    outcome('gmail_list_labels', { failAt: NOW - 2 * MIN, streak: 1 });
    expect(await googleLine()).toMatch(/UNRESOLVED FAILURE on the agent's own account: gmail_list_labels, last failed \[[^\]]+\], 1 in a row, with no later call of that account's tools in this family\./);
  });

  it('a failure of the owner-account twin is tagged as the owner\'s account', async () => {
    outcome('user_gmail_list_labels', { failAt: NOW - 2 * MIN, streak: 2 });
    expect(await googleLine()).toMatch(/UNRESOLVED FAILURE on the owner's account: user_gmail_list_labels,/);
  });
});

describe('rank 6: it expires on a real signal, never on a timer', () => {
  it('a LATER success of another tool on the same account clears it (no exact-tool wait)', async () => {
    outcome('gmail_list_labels', { failAt: NOW - 30 * MIN, streak: 1 });
    outcome('gmail_search', { okAt: NOW - 5 * MIN });
    expect(await googleLine()).toContain('No unresolved tool failure on record.');
  });

  it('a later success on the OTHER account does not clear the agent-account failure', async () => {
    outcome('gmail_list_labels', { failAt: NOW - 30 * MIN, streak: 1 });
    outcome('user_gmail_search', { okAt: NOW - 5 * MIN });
    expect(await googleLine()).toMatch(/UNRESOLVED FAILURE on the agent's own account: gmail_list_labels/);
  });

  it('a later DIFFERENT failure on the same account replaces it: the newest outcome is the status', async () => {
    outcome('gmail_list_labels', { failAt: NOW - 30 * MIN, streak: 1 });
    outcome('gmail_label', { failAt: NOW - 5 * MIN, streak: 3 });
    const line = await googleLine();
    expect(line).toMatch(/UNRESOLVED FAILURE on the agent's own account: gmail_label,/);
    expect(line).not.toContain('gmail_list_labels');
  });

  it('a failure from before the agent\'s current session boundary is history, not an unresolved failure', async () => {
    outcome('gmail_list_labels', { failAt: NOW - 3 * DAY, streak: 1 });
    mockDb.current!.prepare("UPDATE agents SET session_started_at = ? WHERE id = ?").run(stamp(NOW - DAY).slice(0, 19), AGENT);
    expect(await googleLine()).toContain('No unresolved tool failure on record.');
  });

  it('CONTROL: with no boundary and nothing later, an old failure still prints, because nothing has superseded it', async () => {
    outcome('gmail_list_labels', { failAt: NOW - 3 * DAY, streak: 1 });
    expect(await googleLine()).toMatch(/UNRESOLVED FAILURE on the agent's own account: gmail_list_labels/);
  });

  it('the per-tool ledger itself is untouched (the Healer still reads the streak)', async () => {
    outcome('gmail_list_labels', { failAt: NOW - 30 * MIN, streak: 1 });
    outcome('gmail_search', { okAt: NOW - 5 * MIN });
    await googleLine();
    expect((mockDb.current!.prepare("SELECT consecutive_failures AS n FROM agent_tool_outcomes WHERE tool_name = 'gmail_list_labels'").get() as { n: number }).n).toBe(1);
  });
});
