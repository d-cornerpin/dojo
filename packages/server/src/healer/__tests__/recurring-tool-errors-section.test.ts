// K37 — the Healer report lists the week's recurring tool errors: tool, hits, agents, sample,
// and whether a remedy is registered. A report, not a limit.

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
import { noteToolError } from '../../agent/v2/tool-error-ledger.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const ITEM = 'RECURRING_TOOL_ERRORS';
const find = (r: { items: Array<{ code: string; detail: string }> }) => r.items.find((i) => i.code === ITEM);

describe('Healer: recurring tool errors this week', () => {
  it('lists a repeated error with tool, hits, agents, sample and "remedy registered: yes"', () => {
    noteToolError('agent-a', 'gmail_label', 'Error modifying labels: Invalid label: Junk E-mail');
    noteToolError('agent-b', 'gmail_label', 'Error modifying labels: Invalid label: Junk E-mail');
    const item = find(compileDiagnosticReport() as never);
    expect(item).toBeDefined();
    expect(item!.detail).toContain('gmail_label');
    expect(item!.detail).toMatch(/2 hits/);
    expect(item!.detail).toMatch(/2 agents/);
    expect(item!.detail).toContain('Invalid label: Junk E-mail');
    expect(item!.detail).toMatch(/remedy registered: yes/);
  });

  it('an error with no registered remedy says so', () => {
    noteToolError('agent-a', 'some_tool', 'Error: upstream said no');
    noteToolError('agent-a', 'some_tool', 'Error: upstream said no');
    const item = find(compileDiagnosticReport() as never);
    expect(item!.detail).toMatch(/some_tool.*remedy registered: no/s);
  });

  it('an error seen once is not recurring; nothing is reported', () => {
    noteToolError('agent-a', 'some_tool', 'Error: seen once');
    expect(find(compileDiagnosticReport() as never)).toBeUndefined();
  });

  it('an old signature (last seen over a week ago) is not this week\'s', () => {
    noteToolError('agent-a', 'some_tool', 'Error: old news');
    noteToolError('agent-a', 'some_tool', 'Error: old news');
    mockDb.current!.prepare('UPDATE tool_error_signatures SET last_at = last_at - 8 * 86400000').run();
    expect(find(compileDiagnosticReport() as never)).toBeUndefined();
  });
});
