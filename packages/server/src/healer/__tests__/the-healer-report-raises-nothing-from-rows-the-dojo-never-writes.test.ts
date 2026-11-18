// Four Healer checks read rows the dojo never writes (model_call rows are never written as errors,
// tool_call error targets are tool names, text_tool_ ids are never stored), so the report and the
// daily fixer must raise nothing from such rows.

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

type Item = { code: string; severity: string; title: string; detail: string };
const compile = (): Item[] => (compileDiagnosticReport() as { items: Item[] }).items;
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current!.prepare("INSERT INTO agents (id, name, status, config) VALUES ('a1', 'helper one', 'idle', '{}')").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the Healer report raises nothing from rows the dojo never writes', () => {
  it('a failed model call row raises no model or nudge item', () => {
    const add = mockDb.current!.prepare("INSERT INTO audit_log (id, agent_id, action_type, target, result, created_at) VALUES (?, 'a1', 'model_call', 'm1', 'error', datetime('now'))");
    for (let i = 0; i < 5; i++) add.run(`mc-${i}`);
    const items = compile();
    expect(items.some((i) => i.code === 'HIGH_ERROR_RATE')).toBe(false);
    expect(items.some((i) => i.code === 'NUDGE_HEAVY')).toBe(false);
  });

  it('a tool error whose target reads like a raw exception raises no leak item', () => {
    mockDb.current!.prepare("INSERT INTO audit_log (id, agent_id, action_type, target, result, created_at) VALUES ('tc-1', 'a1', 'tool_call', 'Cannot read properties of undefined', 'error', datetime('now'))").run();
    expect(compile().some((i) => i.code === 'TOOL_ERROR_LEAK')).toBe(false);
  });

  it('a tool row with a fallback id raises no corrupted-messages item', () => {
    mockDb.current!.prepare("INSERT INTO messages (id, agent_id, role, content, created_at) VALUES ('t1', 'a1', 'tool', ?, ?)").run(JSON.stringify([{ type: 'tool_result', tool_use_id: 'text_tool_1_0', content: 'x' }]), Date.now());
    expect(compile().some((i) => i.code === 'ORPHANED_TOOL_MESSAGES')).toBe(false);
  });

  it('the daily fixer writes no note for the retired code', () => {
    const count = () => (mockDb.current!.prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = 'a1'").get() as { n: number }).n;
    const before = count();
    const r = runAutoFixes('d1', [{ severity: 'warning', code: 'ORPHANED_TOOL_MESSAGES', title: 't', detail: 'd', agentId: 'a1', agentName: 'helper one' }]);
    expect(r.fixCount).toBe(0);
    expect(count()).toBe(before);
  });
});
